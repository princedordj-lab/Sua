-- Backfill extraction state for assets that predate background extraction.
-- /complete used to parse inline, so a completed legacy asset is either already
-- read (text present, or not a document at all) or its parse failed. Without
-- this, every old row would claim to be "Reading your file" forever.
UPDATE "assets"
   SET "extractState" = 'done'
 WHERE "extractState" = 'pending'
   AND "status" = 'active'
   AND ("extractedText" IS NOT NULL OR "kind" <> 'document');

UPDATE "assets"
   SET "extractState" = 'failed',
       "extractErrorCode" = 'never_extracted'
 WHERE "extractState" = 'pending'
   AND "status" = 'active'
   AND "kind" = 'document';
