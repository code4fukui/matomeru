import { hashPassword, verifyPassword } from "../src/auth.ts";

Deno.test("password hashes verify without storing the password", async () => {
  const hash = await hashPassword("correct horse battery staple");
  if (!hash.startsWith("pbkdf2$")) throw new Error("invalid hash format");
  if (!await verifyPassword("correct horse battery staple", hash)) {
    throw new Error("valid password rejected");
  }
  if (await verifyPassword("wrong password", hash)) throw new Error("invalid password accepted");
});
