export class AppError extends Error {}
export class SessionExpiredError extends AppError {}

export interface SessionRow {
  readonly userId: string;
  readonly expiresAt: number;
}

// TODO: implement CreateUserSession.
//
// Rules:
//   1. Look up the row via the given store.
//   2. If the row is missing or expiresAt is in the past, that is an expected
//      business failure.
//   3. Otherwise return the row.
export const createUserSession = (): SessionRow => {
  throw new Error('not implemented');
};
