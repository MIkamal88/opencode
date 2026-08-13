import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812072206_session-read-receipt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_read_receipt\` (
          \`session_id\` text NOT NULL,
          \`canonical_path\` text NOT NULL,
          \`digest\` text NOT NULL,
          \`settled_seq\` integer NOT NULL,
          \`call_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`session_read_receipt_pk\` PRIMARY KEY(\`session_id\`, \`canonical_path\`),
          CONSTRAINT \`fk_session_read_receipt_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
