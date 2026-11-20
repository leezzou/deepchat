package ai.deepseek.demo.shell;

import static org.junit.Assert.*;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class HistoryArchiveCacheTest {
    private static final String ID = "00112233445566778899aabbccddeeff";
    private static final String NAME = "history-import-" + ID + ".zip";
    @Rule public TemporaryFolder temp = new TemporaryFolder();

    @Test public void seeksNearTwoGiBAndChecksEveryBoundBeforeAllocating() throws Exception {
        File zip = temp.newFile(NAME);
        long size = 1L << 31;
        try (RandomAccessFile output = new RandomAccessFile(zip, "rw")) {
            output.seek(size - 3);
            output.write(new byte[]{12, 42, 76});
        }
        assertArrayEquals(new byte[]{42, 76}, HistoryArchiveCache.readRange(temp.getRoot(), ID, size, size - 2, 2));
        assertEquals(0, HistoryArchiveCache.readRange(temp.getRoot(), ID, size, size, 0).length);
        assertEquals(262144, HistoryArchiveCache.readRange(temp.getRoot(), ID, size, 0, 262144).length);
        for (long[] invalid : new long[][]{{size, 0, 262145}, {size, 0, -1}, {size, -1, 1},
                {size, size, 1}, {size, Long.MAX_VALUE, 4}, {size - 1, 0, 1}, {size + 1, 0, 1}}) {
            assertThrows(IOException.class, () -> HistoryArchiveCache.readRange(temp.getRoot(), ID,
                    invalid[0], invalid[1], invalid[2]));
        }
    }

    @Test public void rejectsPathsAndSymlinks() throws Exception {
        File privateFile = temp.newFile("unrelated");
        Files.createSymbolicLink(new File(temp.getRoot(), NAME).toPath(), privateFile.toPath());
        for (String id : new String[]{null, "", "../unrelated", privateFile.getAbsolutePath(), NAME, ID}) {
            assertThrows(IOException.class, () -> HistoryArchiveCache.readRange(temp.getRoot(), id, 0, 0, 0));
        }
        assertTrue(privateFile.exists());
    }

    @Test public void coldStartRemovesAbandonedZipsAndPreservesActiveImportsOnRecreation() throws Exception {
        File partial = temp.newFile(NAME);
        File old = temp.newFile("history-import-12345678-1234-1234-1234-123456789abc.zip");
        File other = temp.newFile("deepchat-backup.zip");
        HistoryArchiveCache.sweepAtProcessStart(temp.getRoot());
        assertFalse(partial.exists());
        assertFalse(old.exists());
        assertTrue(other.exists());
        File active = temp.newFile(NAME);
        HistoryArchiveCache.sweepAtProcessStart(temp.getRoot());
        assertTrue(active.exists());
    }
}
