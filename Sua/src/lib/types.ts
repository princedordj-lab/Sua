export type Course = {
  id: string;
  code: string;
  name: string;
  lecturer: string;
  color: string;
  noteCount: number;
  archived?: boolean;
};

export type UserProfile = {
  name: string;
  email: string;
  university: string;
  programme: string;
  level: string;
  examDate?: string;
};

export type Note = import("./notes").Note;
