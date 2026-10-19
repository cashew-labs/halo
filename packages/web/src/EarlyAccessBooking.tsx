import Cal, { getCalApi, type EmbedEvent } from "@calcom/embed-react";
import * as errore from "errore";
import { useEffect } from "react";
import { marketingCampaign, trackCallBooking } from "./marketingAnalytics.js";

class BookingEmbedError extends errore.createTaggedError({
  name: "BookingEmbedError",
  message: "Could not initialize early access booking tracking.",
}) {}

export function EarlyAccessBooking({ className }: { className: string }) {
  useEffect(() => {
    let active = true;
    let calApi: Awaited<ReturnType<typeof getCalApi>> | undefined;
    const callback = (event: EmbedEvent<"bookingSuccessfulV2">) => {
      trackCallBooking(event.detail.data.uid);
    };
    const subscribe = async () => {
      const cal = await getCalApi({ namespace: "halo-early-access" }).catch(
        (cause) => new BookingEmbedError({ cause }),
      );
      // coverage-exempt: The Cal SDK rejects only if browser script setup throws; network failures do not reject its namespace promise.
      if (cal instanceof Error) {
        console.warn(cal);
        return;
      }
      if (!active) return;
      calApi = cal;
      cal("on", { action: "bookingSuccessfulV2", callback });
    };
    // oxlint-disable-next-line typescript/no-floating-promises -- This effect owns the subscription and handles embed initialization errors.
    subscribe();
    return () => {
      active = false;
      calApi?.("off", { action: "bookingSuccessfulV2", callback });
    };
  }, []);

  return (
    <Cal
      namespace="halo-early-access"
      calLink="team/halo/halo-early-access-chat"
      calOrigin="https://cal.com"
      className={className}
      config={{ theme: "light", ...marketingCampaign() }}
    />
  );
}
