import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.rdwlabz.puttdrop",
  appName: "Putt Drop",
  webDir: "build/web",
  android: {
    allowMixedContent: false,
  },
};

export default config;
