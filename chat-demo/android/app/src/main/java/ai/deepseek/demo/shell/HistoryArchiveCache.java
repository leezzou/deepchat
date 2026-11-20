package ai.deepseek.demo.shell;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.util.regex.Pattern;

final class HistoryArchiveCache {
    static final int MAX_READ_BYTES = 256 * 1024;
    static final long MAX_ARCHIVE_BYTES = 1L << 31;
    private static final Pattern ID = Pattern.compile("[0-9a-f]{32}");
    // Include crash remnants from the old downloader (createId's UUID and fallback).
    private static final Pattern OWNED_NAME = Pattern.compile("history-import-(?:[0-9a-f]{32}|"
            + "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-z]{1,12}-[0-9a-z]{0,16})\\.zip");
    private static boolean swept;

    /** Called before Capacitor starts the page, only once per process. Activity recreation
     * must not unlink a file still in use by an active download or reader. */
    static synchronized void sweepAtProcessStart(File directory) {
        if (swept) return;
        swept = true;
        File[] files = directory.listFiles((dir, name) -> OWNED_NAME.matcher(name).matches());
        if (files == null) return;
        for (File file : files) {
            if (file.isFile()) file.delete(); // Best effort. On failure retry next cold start.
        }
    }

    static byte[] readRange(File directory, String id, long size, long offset, long length) throws IOException {
        if (id == null || !ID.matcher(id).matches() || size < 0 || size > MAX_ARCHIVE_BYTES
                || offset < 0 || length < 0 || length > MAX_READ_BYTES || offset > size - length) {
            throw new IOException();
        }
        File cache = new File(directory.getCanonicalFile(), "history-import-" + id + ".zip");
        if (!cache.equals(cache.getCanonicalFile()) || !cache.isFile()) throw new IOException();
        try (RandomAccessFile input = new RandomAccessFile(cache, "r")) {
            if (input.length() != size) throw new IOException();
            input.seek(offset);
            byte[] bytes = new byte[(int) length];
            input.readFully(bytes);
            return bytes;
        }
    }

    private HistoryArchiveCache() {}
}
