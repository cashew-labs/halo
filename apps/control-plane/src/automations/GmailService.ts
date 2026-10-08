import type { AutomationSourceState } from "@get-halo/client";
import type { IntegrationService } from "../integrations/IntegrationService.js";
import {
  registrationActivation,
  type AutomationStore,
  type TriggerRegistration,
} from "./AutomationStore.js";
import { GmailApi, GmailApiError, type GmailAccount } from "./GmailApi.js";
import {
  GmailStore,
  type GmailMailbox,
  type GmailSource,
} from "./GmailStore.js";

type GmailConfiguration = {
  topic: string;
  audience: string;
  serviceAccount: string;
};

/** Control-plane owner of watch renewal, history cursors and mailbox fanout. */
export class GmailService {
  readonly store: GmailStore;
  readonly configuration: GmailConfiguration | undefined;
  private readonly api: GmailApi | undefined;
  private timer: NodeJS.Timeout | undefined;
  private working: Promise<void> | undefined;
  private closed = false;
  constructor(ctx: {
    automations: AutomationStore;
    integrations?: IntegrationService;
    configuration?: GmailConfiguration;
  }) {
    this.store = new GmailStore({ automations: ctx.automations });
    this.configuration = ctx.configuration;
    this.api =
      ctx.integrations === undefined
        ? undefined
        : new GmailApi({ integrations: ctx.integrations });
  }
  async start() {
    const initialized = await this.store.initialize();
    if (initialized instanceof Error) return initialized;
    this.timer = setInterval(() => this.schedule(), 5000);
    this.timer.unref();
    this.schedule();
  }
  schedule() {
    if (this.closed || this.working !== undefined) return;
    this.working = this.tick().then(() => {
      this.working = undefined;
    });
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.working;
  }

  async state(
    registration: TriggerRegistration,
  ): Promise<
    | Pick<
        AutomationSourceState,
        "status" | "detail" | "emailAddress" | "expiresAt"
      >
    | Error
  > {
    if (this.configuration === undefined || this.api === undefined)
      return {
        status: "needsAttention",
        detail: "Gmail triggers are not configured on this control plane.",
      };
    const source = await this.store.source(registration);
    if (source instanceof Error) return source;
    if (source === undefined) {
      this.schedule();
      return {
        status: registration.source_status,
        detail: registration.source_error ?? undefined,
      };
    }
    const mailbox = await this.store.mailbox(source.email);
    if (mailbox instanceof Error) return mailbox;
    return {
      status: registration.source_status,
      detail: registration.source_error ?? mailbox?.gap ?? undefined,
      emailAddress: source.email,
      expiresAt:
        mailbox?.expiration === null || mailbox?.expiration === undefined
          ? undefined
          : new Date(Number(mailbox.expiration)).toISOString(),
    };
  }

  private async tick() {
    const api = this.api;
    const configuration = this.configuration;
    if (api === undefined || configuration === undefined) return;
    const cleaned = await this.store.cleanup();
    if (cleaned instanceof Error) {
      console.error(cleaned);
      return;
    }
    const registrations = await this.store.pending();
    if (registrations instanceof Error) {
      console.error(registrations);
      return;
    }
    for (const registration of registrations) {
      if (this.closed) return;
      if (registration.deleted === 1 || registration.enabled === 0) continue;
      const activation = registrationActivation(registration);
      if (activation instanceof Error) {
        console.error(activation);
        continue;
      }
      if (activation.trigger.type !== "gmail") continue;
      const deferred = await this.store.deferSetup(registration);
      if (deferred instanceof Error) {
        console.error(deferred);
        continue;
      }
      const profile = await api.profile({
        ownerId: registration.owner_id,
        connectionAddress: activation.trigger.connectionAddress,
      });
      if (profile instanceof Error) {
        await this.setStatus(registration, "needsAttention", profile.message);
        continue;
      }
      const bound = await this.store.bind(
        registration,
        profile,
        activation.trigger.connectionAddress,
      );
      if (bound instanceof Error) {
        console.error(bound);
        continue;
      }
    }
    for (let index = 0; index < 10 && !this.closed; index++) {
      const mailbox = await this.store.claim();
      if (mailbox instanceof Error) {
        console.error(mailbox);
        return;
      }
      if (mailbox === undefined) return;
      const result = await this.syncMailbox(mailbox, api, configuration);
      if (result instanceof Error) console.warn(result.message);
      const released = await this.store.release(
        mailbox,
        result instanceof Error ? 60_000 : undefined,
      );
      if (released instanceof Error) console.error(released);
    }
  }

  private async syncMailbox(
    mailbox: GmailMailbox,
    api: GmailApi,
    configuration: GmailConfiguration,
  ) {
    const sources = await this.store.sources(mailbox.email);
    if (sources instanceof Error) return sources;
    if (sources.length === 0) {
      const stopped = await api.stop({
        ownerId: mailbox.owner_id,
        connectionAddress: mailbox.connection_address,
      });
      if (stopped instanceof GmailApiError && stopped.status === "401")
        return await this.store.remove(mailbox);
      if (stopped instanceof Error) return stopped;
      return await this.store.remove(mailbox);
    }
    const valid: (GmailSource & TriggerRegistration)[] = [];
    // Each owner's connection must still authorize this mailbox before it receives data.
    for (const source of sources) {
      const renewedLease = await this.store.keepLease(mailbox);
      if (renewedLease instanceof Error) return renewedLease;
      const profile = await api.profile({
        ownerId: source.owner_id,
        connectionAddress: source.connection_address,
      });
      if (profile instanceof Error) {
        await this.setStatus(source, "needsAttention", profile.message);
        continue;
      }
      if (profile.emailAddress.toLowerCase() !== mailbox.email) {
        await this.setStatus(
          source,
          "needsAttention",
          "The connection now belongs to another mailbox. Save the trigger again to reconnect it.",
        );
        continue;
      }
      valid.push(source);
    }
    if (valid.length === 0)
      return new GmailApiError({
        status: "401",
        detail: "No active Gmail connection can read this mailbox",
      });
    const first = valid[0]!;
    const account: GmailAccount = {
      ownerId: first.owner_id,
      connectionAddress: first.connection_address,
    };
    if (Number(mailbox.renew_at) <= Date.now()) {
      const watch = await api.watch(account, configuration.topic);
      if (watch instanceof Error) {
        for (const source of valid)
          await this.setStatus(source, "needsAttention", watch.message);
        return watch;
      }
      const renewed = await this.store.renew(mailbox, watch, account);
      if (renewed instanceof Error) return renewed;
    }
    let pageToken: string | undefined = undefined;
    for (let page = 0; page < 20 && !this.closed; page++) {
      const renewedLease = await this.store.keepLease(mailbox);
      if (renewedLease instanceof Error) return renewedLease;
      const history = await api.history(account, mailbox.cursor, pageToken);
      if (history instanceof GmailApiError && history.status === "404") {
        const profile = await api.profile(account);
        if (profile instanceof Error) return profile;
        const gap =
          "Gmail history expired. Listening from now; some messages in the gap could not be processed.";
        const reset = await this.store.commitPage(
          mailbox,
          profile.historyId,
          [],
          gap,
        );
        if (reset instanceof Error) return reset;
        for (const source of valid) await this.setStatus(source, "active", gap);
        return;
      }
      if (history instanceof Error) {
        for (const source of valid)
          await this.setStatus(source, "needsAttention", history.message);
        return history;
      }
      const matches: Parameters<GmailStore["commitPage"]>[2] = [];
      for (const entry of history.history ?? []) {
        for (const added of entry.messagesAdded ?? []) {
          const labels = added.message.labelIds ?? [];
          if (
            !labels.includes("INBOX") ||
            labels.includes("SENT") ||
            labels.includes("DRAFT")
          )
            continue;
          const candidates = valid.filter(
            (source) => BigInt(entry.id) > BigInt(source.baseline),
          );
          if (candidates.length === 0) continue;
          const messageLease = await this.store.keepLease(mailbox);
          if (messageLease instanceof Error) return messageLease;
          const message = await api.message(account, added.message.id);
          if (message instanceof GmailApiError && message.status === "404")
            continue;
          if (message instanceof Error) return message;
          const headers = message.payload?.headers ?? [];
          const from =
            headers.find((header) => header.name.toLowerCase() === "from")
              ?.value ?? "";
          const subject =
            headers.find((header) => header.name.toLowerCase() === "subject")
              ?.value ?? "";
          const sender = (/<([^<>]+)>/.exec(from)?.[1] ?? from)
            .trim()
            .toLowerCase();
          for (const source of candidates) {
            const activation = registrationActivation(source);
            if (activation instanceof Error) return activation;
            if (activation.trigger.type !== "gmail") continue;
            const trigger = activation.trigger;
            if (
              trigger.from !== undefined &&
              sender !== trigger.from.trim().toLowerCase()
            )
              continue;
            if (
              trigger.subjectContains !== undefined &&
              !subject
                .toLowerCase()
                .includes(trigger.subjectContains.toLowerCase())
            )
              continue;
            matches.push({
              registration: source,
              message,
              payload: {
                emailAddress: mailbox.email,
                messageId: message.id,
                threadId: message.threadId ?? "",
                from,
                subject,
                snippet: message.snippet ?? "",
              },
            });
          }
        }
      }
      matches.sort(
        (a, b) =>
          a.registration.workspace_id.localeCompare(
            b.registration.workspace_id,
          ) ||
          a.registration.automation_id.localeCompare(
            b.registration.automation_id,
          ),
      );
      const cursor =
        history.nextPageToken === undefined
          ? history.historyId
          : (history.history?.at(-1)?.id ?? mailbox.cursor);
      const committed = await this.store.commitPage(mailbox, cursor, matches);
      if (committed instanceof Error) return committed;
      if (history.nextPageToken === undefined) {
        for (const source of valid) await this.setStatus(source, "active");
        return;
      }
      pageToken = history.nextPageToken;
    }
    // A large catch-up is resumed from the last committed page without waiting for a push.
    const dirty = await this.store.markDirty(mailbox.email);
    if (dirty instanceof Error) return dirty;
  }
  private async setStatus(
    registration: TriggerRegistration,
    status: TriggerRegistration["source_status"],
    error?: string,
  ) {
    const saved = await this.store.status(registration, status, error);
    if (saved instanceof Error) console.error(saved);
  }
}
