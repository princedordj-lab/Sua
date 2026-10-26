import { Suspense } from "react";
import { LoadingBlock } from "@/components/ui";
import { CreateWorkspace } from "./create-client";

export default function CreatePage() {
  return (
    <Suspense fallback={<LoadingBlock rows={4} />}>
      <CreateWorkspace />
    </Suspense>
  );
}
