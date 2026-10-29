/** A record a run's tools returned, by id only: what an answer may cite and the run log keeps. */
export interface RecordRef {
  type: 'order' | 'customer' | 'partner' | 'invoice' | 'job' | 'article' | 'step';
  id: string;
}
