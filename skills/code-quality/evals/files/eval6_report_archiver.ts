export interface AnalyticsClient {
  fetchEvents(params: { readonly since: string }): Promise<readonly EventRow[]>;
}

export interface ObjectStore {
  put(key: string, body: string): Promise<void>;
}

export interface EventRow {
  readonly name: string;
  readonly score: number;
  readonly occurredAt: string;
}

export const MIN_SCORE = 40;

// TODO: implement archiveHighScoreEvents.
//
// Rules:
//   1. Fetch events from the analytics API for the given `since` timestamp.
//   2. Keep only rows whose score is at or above MIN_SCORE.
//   3. Serialize the kept rows as JSON and write them to the object store under
//      the key `reports/<since>.json`.
//   4. An empty result must STILL be written (an empty array), so downstream
//      consumers can distinguish "ran, found nothing" from "never ran".
//   5. Return the number of rows written.
export const archiveHighScoreEvents = async (): Promise<number> => {
  throw new Error('not implemented');
};
