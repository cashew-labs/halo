import * as errore from "errore";

export class DatabaseError extends errore.createTaggedError({
  name: "DatabaseError",
  message: "Application database failed during $operation",
}) {}
