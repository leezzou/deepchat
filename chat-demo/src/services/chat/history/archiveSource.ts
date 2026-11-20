/** A downloaded Android archive has no WebView Blob. Its owner keeps the private file
 * alive until confirmation/cancellation and all import transactions have finished. */
export type ArchiveSource = File | {
  readonly name: string
  readonly size: number
  readRange(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>>
}

// Also enforced by HistoryArchiveCache before allocating a native result.
export const MAX_ARCHIVE_READ_BYTES = 256 * 1024
