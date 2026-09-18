import { updateOAuthState } from "../../oauth-store.ts";

const file = process.argv[2];

if (!file) throw new Error("Missing state path");

for (let i = 0; i < 8; i += 1) {
  await updateOAuthState(file, (state) => {
    state.tokens = {
      access_token: String(Number(state.tokens?.access_token ?? "0") + 1),
      token_type: "Bearer",
    };
  });
}
