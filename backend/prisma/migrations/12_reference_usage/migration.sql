-- Course-reference generations used to be counted as a summary + study set.
-- They are a distinct AI product (a condensed reference sheet), so track them
-- in their own monthly counter for caps and cost reporting.
ALTER TABLE "usages" ADD COLUMN "references" INTEGER NOT NULL DEFAULT 0;
