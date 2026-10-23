-- Note kinds: "note" = study note, "reference" = AI course reference sheet.
ALTER TABLE "notes" ADD COLUMN "noteKind" TEXT NOT NULL DEFAULT 'note';

-- Asset.task records the destination the student picked for an upload
-- (none = plain upload; lecture_note / course_reference = auto AI conversion).
ALTER TABLE "assets" ADD COLUMN "task" TEXT NOT NULL DEFAULT 'none';

-- Missing Asset → Note relation the AI pipeline already relies on
-- (processStudySet includes note.assets). Deleting a note keeps its files
-- but detaches them from the gone row.
CREATE INDEX "assets_noteId_idx" ON "assets"("noteId");
ALTER TABLE "assets" ADD CONSTRAINT "assets_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
