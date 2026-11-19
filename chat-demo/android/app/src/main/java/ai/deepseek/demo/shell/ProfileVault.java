package ai.deepseek.demo.shell;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** A single versioned, device-bound envelope. Never share the native account credential alias. */
final class ProfileVault {
    private static final String ALIAS = "deepchat-api-profiles-v1";
    private static final int MAX_BYTES = 2 * 1024 * 1024;
    private final AtomicFile file;

    ProfileVault(Context context) {
        file = new AtomicFile(new File(context.getNoBackupFilesDir(), ALIAS));
    }

    private SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        SecretKey existing = (SecretKey) store.getKey(ALIAS, null);
        if (existing != null) return existing;
        if (!create) throw new IOException("Key unavailable");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }

    String read() throws Exception {
        byte[] bytes;
        try {
            bytes = file.readFully();
        } catch (FileNotFoundException missing) {
            if (file.getBaseFile().exists()) throw missing;
            return null;
        }
        if (bytes.length < 29 || bytes.length > MAX_BYTES + 29 || bytes[0] != 1) throw new IOException();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, bytes, 1, 12));
        return new String(cipher.doFinal(bytes, 13, bytes.length - 13), StandardCharsets.UTF_8);
    }

    void write(String value) throws Exception {
        byte[] plain = value.getBytes(StandardCharsets.UTF_8);
        try {
            if (plain.length > MAX_BYTES) throw new IOException();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key(true));
            byte[] iv = cipher.getIV();
            if (iv.length != 12) throw new IOException();
            byte[] encrypted = cipher.doFinal(plain);
            byte[] envelope = ByteBuffer.allocate(13 + encrypted.length).put((byte) 1).put(iv).put(encrypted).array();
            FileOutputStream output = file.startWrite();
            try {
                output.write(envelope);
                file.finishWrite(output);
            } catch (Exception failure) {
                file.failWrite(output);
                throw failure;
            }
            if (!value.equals(read())) throw new IOException("Readback failed");
        } finally {
            Arrays.fill(plain, (byte) 0);
        }
    }
}
