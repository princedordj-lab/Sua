import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Course, UserProfile } from "../lib/types";

const starterCourses: Course[] = [
  { id: "cs-101", code: "CS 241", name: "Data Structures", lecturer: "Dr. K. Mensah", color: "#7C5CFC", noteCount: 12 },
  { id: "ec-204", code: "ECON 204", name: "Microeconomics II", lecturer: "Prof. A. Owusu", color: "#17B890", noteCount: 8 },
  { id: "st-110", code: "STAT 110", name: "Probability & Statistics", lecturer: "Dr. A. Boateng", color: "#F59E0B", noteCount: 5 },
];

type AppContextValue = {
  isSignedIn: boolean;
  hasCompletedOnboarding: boolean;
  profile: UserProfile | null;
  courses: Course[];
  signIn: (email: string, name?: string) => void;
  signOut: () => void;
  completeOnboarding: (profile: UserProfile, firstCourse: Course) => void;
  addCourse: (course: Omit<Course, "id">) => void;
  updateCourse: (id: string, changes: Partial<Course>) => void;
  deleteCourse: (id: string) => void;
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const value = useMemo<AppContextValue>(() => ({
    isSignedIn,
    hasCompletedOnboarding,
    profile,
    courses,
    signIn: (email, name = email.split("@")[0]) => {
      setIsSignedIn(true);
      setProfile((current) => current ?? { name, email, university: "", programme: "", level: "" });
    },
    signOut: () => { setIsSignedIn(false); setHasCompletedOnboarding(false); },
    completeOnboarding: (nextProfile, firstCourse) => {
      setProfile(nextProfile);
      setCourses((current) => current.length ? current : [firstCourse]);
      setHasCompletedOnboarding(true);
    },
    addCourse: (course) => setCourses((current) => [...current, { ...course, id: `course-${Date.now()}` }]),
    updateCourse: (id, changes) => setCourses((current) => current.map((course) => course.id === id ? { ...course, ...changes } : course)),
    deleteCourse: (id) => setCourses((current) => current.filter((course) => course.id !== id)),
  }), [courses, hasCompletedOnboarding, isSignedIn, profile]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used inside AppProvider");
  return context;
}
