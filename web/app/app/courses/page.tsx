import { Suspense } from "react";
import { CoursesClient } from "./courses-client";

function CoursesSkeleton() {
  return (
    <div aria-busy="true" className="course-grid">
      <div className="skeleton h-8 w-40" />
      <div className="skeleton h-20 w-full" />
      <div className="skeleton h-32" />
      <div className="skeleton h-32" />
    </div>
  );
}

export default function CoursesPage() {
  return (
    <Suspense fallback={<CoursesSkeleton />}>
      <CoursesClient />
    </Suspense>
  );
}
