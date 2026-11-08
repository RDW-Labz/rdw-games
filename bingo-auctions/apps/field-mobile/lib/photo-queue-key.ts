// Shared storage key for the persistent photo upload queue. Pruning reads the
// queue directly, so the key lives here to keep both modules in sync.
export const PHOTO_QUEUE_KEY = 'lotting:photo-upload-queue:v1';
export const PHOTO_QUEUE_CORRUPT_KEY = `${PHOTO_QUEUE_KEY}:corrupt`;
// Receipts prove a local file was already uploaded AND attached to its lot.
// Without them a missing file is indistinguishable from a photo that never
// made it, so a retry could report a lost hero as saved.
export const PHOTO_RECEIPTS_KEY = 'lotting:photo-upload-receipts:v1';
