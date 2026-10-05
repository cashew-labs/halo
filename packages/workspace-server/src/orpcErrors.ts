import { ORPCError } from "@orpc/server";

export const orpcErrors = {
  badRequest(error: Error) {
    return new ORPCError("BAD_REQUEST", {
      message: error.message,
      data: { message: error.message },
    });
  },
};
