import {
  OpenApiParseError,
  type SpecFormatAdapter,
} from "@executor-js/plugin-openapi/core";
import {
  convertGoogleDiscoveryBundleToOpenApi,
  googleDiscoveryAdapter as executorGoogleDiscoveryAdapter,
} from "@executor-js/plugin-openapi/providers/google";
import { Effect, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";

// Google identity scopes are valid across APIs and need not appear in Discovery.
const googleIdentityScopes = new Set(["openid", "email", "profile"]);
const discoveryPermissions = Schema.fromJsonString(
  Schema.Struct({
    auth: Schema.optional(
      Schema.Struct({
        oauth2: Schema.optional(
          Schema.Struct({
            scopes: Schema.optional(
              Schema.Record(Schema.String, Schema.Unknown),
            ),
          }),
        ),
      }),
    ),
  }),
);

// Executor 1.6 rewrites service-hosted URLs (including Analytics) to legacy
// endpoints that return 404. Preserve published URLs and keep its converter.
function createGoogleDiscoveryAdapter(ctx: {
  id: string;
  validateScopes: boolean;
}): SpecFormatAdapter {
  return {
    ...executorGoogleDiscoveryAdapter,
    id: ctx.id,
    fetch: (input) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const documents = yield* Effect.forEach(input.urls, (url) =>
          Effect.gen(function* () {
            const response = yield* client.get(url, {
              headers: input.credentials?.headers,
              urlParams: input.credentials?.queryParams,
            });
            if (response.status < 200 || response.status >= 300)
              return yield* new OpenApiParseError({
                message: `Couldn't load Google API description: HTTP ${response.status}. Check the provider's description URL.`,
              });
            return { discoveryUrl: url, documentText: yield* response.text };
          }).pipe(
            Effect.mapError((cause) => {
              if (cause instanceof OpenApiParseError) return cause;
              const error = new OpenApiParseError({
                message:
                  "Couldn't load Google API description. Check the provider's description URL and try again.",
              });
              error.cause = cause;
              return error;
            }),
          ),
        );
        if (ctx.validateScopes && input.consentScopes !== undefined) {
          const permissions = yield* Effect.forEach(
            documents,
            ({ documentText }) =>
              Schema.decodeUnknownEffect(discoveryPermissions)(
                documentText,
              ).pipe(
                Effect.mapError((cause) => {
                  const error = new OpenApiParseError({
                    message: "Failed to parse Google Discovery document",
                  });
                  error.cause = cause;
                  return error;
                }),
              ),
          );
          const declaredScopes = new Set(
            permissions.flatMap((doc) =>
              Object.keys(doc.auth?.oauth2?.scopes ?? {}),
            ),
          );
          const unsupportedScope = input.consentScopes.find(
            (scope) =>
              !googleIdentityScopes.has(scope) && !declaredScopes.has(scope),
          );
          if (unsupportedScope !== undefined)
            return yield* new OpenApiParseError({
              message: `This API does not support OAuth scope "${unsupportedScope}". Choose scopes declared in its API description.`,
            });
        }
        const converted = yield* convertGoogleDiscoveryBundleToOpenApi({
          documents,
          consentScopes: input.consentScopes,
        });
        return { ...converted, specUrl: input.urls[0] };
      }).pipe(Effect.provide(input.httpClientLayer)),
  };
}

export const googleDiscoveryAdapter = createGoogleDiscoveryAdapter({
  id: executorGoogleDiscoveryAdapter.id,
  validateScopes: false,
});

export const scopedGoogleDiscoveryAdapter = createGoogleDiscoveryAdapter({
  id: "halo-google-discovery-scoped",
  validateScopes: true,
});
