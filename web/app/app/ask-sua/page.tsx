import { Suspense } from "react";
import { LoadingBlock } from "@/components/ui";
import { AskSuaClient } from "./ask-client";

export default function AskSuaPage() {
  return (
    <Suspense
      fallback={
        <div className="ask-loading-fallback">
          <LoadingBlock rows={5} />
        </div>
      }
    >
      <AskSuaClient />
    </Suspense>
  );
}
