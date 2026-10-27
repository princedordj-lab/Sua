import { Suspense } from "react";
import { CourseDetailClient } from "./course-detail-client";

function CourseDetailSkeleton() {
  return (
    <div className="course-detail" aria-busy="true">
      <div className="skeleton h-5 w-28" />
      <div className="card course-hero grid gap-3">
        <div className="skeleton h-20 w-2/3" />
        <div className="skeleton h-16 w-full" />
      </div>
      <div className="skeleton h-12 w-full" />
      <div className="skeleton h-24 w-full" />
    </div>
  );
}

export default function CourseDetailPage() {
  return (
    <Suspense fallback={<CourseDetailSkeleton />}>
      <CourseDetailClient />
    </Suspense>
  );
}
