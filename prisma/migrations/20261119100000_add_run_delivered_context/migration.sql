-- docs/specs/external-context-delivery.md. The context files of the work sprite, without content.
ALTER TABLE "Run" ADD COLUMN "delivered_context" JSONB;
