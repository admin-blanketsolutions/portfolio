export const TB_PARSER = Symbol('TB_PARSER');
export const TB_OBJECT_STORE = Symbol('TB_OBJECT_STORE');
export const JOB_QUEUE = Symbol('JOB_QUEUE');
export const JOB_CODEC = Symbol('JOB_CODEC');
export const ACCOUNT_CLASSIFIER = Symbol('ACCOUNT_CLASSIFIER');
export const TB_IMPORT_WORKER = Symbol('TB_IMPORT_WORKER');
export const INGESTION_SETTINGS = Symbol('INGESTION_SETTINGS');

export interface IngestionSettings {
  maxUploadBytes: number;
}
