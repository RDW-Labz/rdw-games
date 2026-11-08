import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appManifestPath = path.join(
  import.meta.dirname,
  "../android/app/src/main/AndroidManifest.xml"
);
const purchasePluginXml = path.join(
  import.meta.dirname,
  "../node_modules/cordova-plugin-purchase/plugin.xml"
);

/**
 * Exact uses-permission list of the MERGED release manifest. CI dumps the signed AAB with
 * bundletool and diffs against this file; reasons per permission are in docs/billing.md.
 */
const expectedMerged = readFileSync(
  path.join(import.meta.dirname, "../android/merged-permissions.expected.txt"),
  "utf8"
)
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

describe("AndroidManifest.xml", () => {
  const appXml = readFileSync(appManifestPath, "utf8");
  const pluginXml = readFileSync(purchasePluginXml, "utf8");

  it("locks package / application id com.rdwlabz.puttdrop", () => {
    expect(appXml).toMatch(/package="com\.rdwlabz\.puttdrop"/);
    expect(appXml).toMatch(/android:name="\.MainActivity"/);
  });

  it("is portrait-only", () => {
    expect(appXml).toMatch(/android:screenOrientation="userPortrait"/);
  });

  it("committed app manifest declares no uses-permission (offline shell)", () => {
    const permissions = [...appXml.matchAll(/<uses-permission[^>]+android:name="([^"]+)"/g)].map(
      (m) => m[1]
    );
    expect(permissions).toEqual([]);
  });

  it("cordova-plugin-purchase itself declares only com.android.vending.BILLING", () => {
    const permissions = [...pluginXml.matchAll(/<uses-permission[^>]+android:name="([^"]+)"/g)].map(
      (m) => m[1]
    );
    expect(permissions).toEqual(["com.android.vending.BILLING"]);
    expect(pluginXml).toMatch(/<framework src="com\.android\.billingclient:billing:9\.0\.0" \/>/);
  });

  it("expected merged permission list is exact and justified", () => {
    expect(expectedMerged).toEqual([
      "android.permission.ACCESS_NETWORK_STATE", // Play Billing Library -> datatransport (its own logging)
      "android.permission.INTERNET", // Play Billing Library -> datatransport transport-backend-cct
      "android.permission.VIBRATE", // @capacitor/haptics (already on main)
      "com.android.vending.BILLING", // Play Billing Library + cordova-plugin-purchase
      "com.rdwlabz.puttdrop.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION", // androidx.core >= 1.9, app-private
    ]);
  });
});
