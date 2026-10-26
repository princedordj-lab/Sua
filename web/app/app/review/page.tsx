import { Suspense } from "react";
import { LoadingBlock } from "@/components/ui";
import { ReviewWorkspace } from "./review-client";

export default function ReviewPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={4} />}>
      <ReviewWorkspace />
    </Suspense>
  );
}
