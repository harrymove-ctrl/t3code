import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { ZrouteSettings } from "./settings.ts";

export const zrouteClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("zroute"),
  label: "zroute",
  settingsSchema: ZrouteSettings,
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#0F0F0F", dark: "#F5F5F5" },
    paths: [{ d: "M4 3h16v3.2L9.6 17.8H20V21H4v-3.2L14.4 6.2H4z" }],
  },
});
