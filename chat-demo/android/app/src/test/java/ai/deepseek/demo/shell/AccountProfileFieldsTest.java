package ai.deepseek.demo.shell;

import org.junit.Test;
import static org.junit.Assert.*;

public class AccountProfileFieldsTest {
    @Test public void preservesPublicProviderPicturesAndUpgradesKnownWechatCdn() {
        assertEquals("https://cdn.example.org/a.jpg?size=200", AccountProfileFields.avatar("//cdn.example.org/a.jpg?size=200"));
        assertEquals("https://thirdwx.qlogo.cn/mmopen/id/132", AccountProfileFields.avatar("http://thirdwx.qlogo.cn/mmopen/id/132"));
        for (Object unsafe : new Object[] {null, 1, "file:///data/local", "javascript:alert(1)", "http://public.example.org/image",
                "https://user:secret@images.example.org/a", "https://localhost/a", "https://[::1]/a", "https://127.0.0.1/a",
                "https://a.local/a", "https://a.example.org/?%61ccess_token=private", "https://a.example.org:8443/a", "https://a.example.org/a#b", "https://a.example.org\\@bad.example/"}) {
            assertEquals("", AccountProfileFields.avatar(unsafe));
        }
    }
    @Test public void trimsDisplayNameAndPreservesUnicodeGraphemeCodepoints() {
        assertEquals("", AccountProfileFields.name(null));
        assertEquals("", AccountProfileFields.name(42));
        assertEquals("昵称", AccountProfileFields.name("  昵\u202e称\n"));
        StringBuilder input = new StringBuilder();
        for (int i = 0; i < 100; i++) input.append("😀");
        String output = AccountProfileFields.name(input.toString());
        assertEquals(80, output.codePointCount(0, output.length()));
        assertEquals(0x1f600, output.codePointBefore(output.length()));
    }
}
