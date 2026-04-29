/**
 * CLO-458 — Migration: backfill limitsCached on existing subscriptions
 *
 * Updates every SUBSCRIPTION#primary item whose limitsCached is missing
 * one or more of the three standard features introduced in the Vitas Pro plan:
 *   scribe_minutes: 200
 *   chatbot_messages: 200
 *   whatsapp_conversations: 80
 *
 * Items that already have all three keys at the correct values are skipped.
 *
 * Usage:
 *   npx ts-node scripts/migrate-subscription-limits.ts --dry-run
 *   npx ts-node scripts/migrate-subscription-limits.ts
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const CORE_TABLE = process.env.CORE_TABLE_NAME ?? "vitas-SaasCore-dev";

const client = new DynamoDBClient({
  region: "sa-east-1",
});
const doc = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

const DRY_RUN = process.argv.includes("--dry-run");

const CORRECT_LIMITS: Record<string, number> = {
  scribe_minutes: 200,
  chatbot_messages: 200,
  whatsapp_conversations: 80,
};

function needsMigration(limitsCached: Record<string, number> | undefined): boolean {
  if (!limitsCached) return true;
  return Object.entries(CORRECT_LIMITS).some(
    ([key, val]) => limitsCached[key] !== val,
  );
}

async function migrate() {
  console.log(`\n=== Subscription limits migration ${DRY_RUN ? "(DRY RUN)" : "(LIVE)"} ===`);
  console.log(`Table: ${CORE_TABLE}\n`);

  let lastKey: Record<string, any> | undefined;
  let scanned = 0;
  let migrated = 0;
  let skipped = 0;

  do {
    const result = await doc.send(
      new ScanCommand({
        TableName: CORE_TABLE,
        FilterExpression: "SK = :sk",
        ExpressionAttributeValues: { ":sk": "SUBSCRIPTION#primary" },
        ProjectionExpression: "PK, SK, userId, limitsCached",
        ExclusiveStartKey: lastKey,
      }),
    );

    lastKey = result.LastEvaluatedKey;
    const items = result.Items ?? [];
    scanned += items.length;

    for (const item of items) {
      const userId = item.userId ?? item.PK?.replace("USER#", "");

      if (!needsMigration(item.limitsCached)) {
        skipped++;
        console.log(`  [SKIP] ${userId} — limits already correct`);
        continue;
      }

      const old = JSON.stringify(item.limitsCached ?? {});
      console.log(`  [MIGRATE] ${userId} — old: ${old} → new: ${JSON.stringify(CORRECT_LIMITS)}`);
      migrated++;

      if (!DRY_RUN) {
        await doc.send(
          new UpdateCommand({
            TableName: CORE_TABLE,
            Key: { PK: item.PK, SK: "SUBSCRIPTION#primary" },
            UpdateExpression: "SET limitsCached = :lc, updatedAt = :ua",
            ExpressionAttributeValues: {
              ":lc": CORRECT_LIMITS,
              ":ua": new Date().toISOString(),
            },
          }),
        );
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  } while (lastKey);

  console.log(`\n=== Summary ===`);
  console.log(`Scanned:  ${scanned}`);
  console.log(`Migrated: ${migrated}`);
  console.log(`Skipped:  ${skipped}`);
  console.log(`Mode:     ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE (writes committed)"}\n`);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
