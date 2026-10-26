"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useMemo } from "react";
import {
  ApiError,
  apiRequest,
  chatApi,
  coursesApi,
  jobsApi,
  notesApi,
  profileApi,
  studyApi,
  uploadsApi,
  type AttemptInput,
  type ReviewLogInput,
} from "./api";

type RequestOptions = Parameters<typeof apiRequest>[2];

export function useApi() {
  const { getToken } = useAuth();

  const withToken = useCallback(
    async <T,>(run: (token: string) => Promise<T>): Promise<T> => {
      const token = await getToken();
      if (!token) throw new ApiError("Your session expired. Please sign in again.", 401);
      return run(token);
    },
    [getToken],
  );

  return useMemo(
    () => ({
      request: <T,>(path: string, options?: RequestOptions) =>
        withToken((token) => apiRequest<T>(token, path, options)),
      profile: {
        get: () => withToken(profileApi.get),
        update: (changes: Parameters<typeof profileApi.update>[1]) =>
          withToken((token) => profileApi.update(token, changes)),
        deleteAccount: () => withToken(profileApi.deleteAccount),
      },
      courses: {
        list: () => withToken(coursesApi.list),
        create: (course: Parameters<typeof coursesApi.create>[1]) =>
          withToken((token) => coursesApi.create(token, course)),
        update: (id: string, changes: Parameters<typeof coursesApi.update>[2]) =>
          withToken((token) => coursesApi.update(token, id, changes)),
        remove: (id: string, moveToCourseId?: string) =>
          withToken((token) => coursesApi.remove(token, id, moveToCourseId)),
      },
      notes: {
        get: (noteId: string) => withToken((token) => notesApi.get(token, noteId)),
        listForCourse: (courseId: string) =>
          withToken((token) => notesApi.listForCourse(token, courseId)),
        sync: (changes: Parameters<typeof notesApi.sync>[1]) =>
          withToken((token) => notesApi.sync(token, changes)),
        study: (noteId: string) => withToken((token) => notesApi.study(token, noteId)),
      },
      uploads: {
        sign: (input: Parameters<typeof uploadsApi.sign>[1]) =>
          withToken((token) => uploadsApi.sign(token, input)),
        complete: (id: string, publicId: string) =>
          withToken((token) => uploadsApi.complete(token, id, publicId)),
        assetUrl: (id: string) => withToken((token) => uploadsApi.assetUrl(token, id)),
        remove: (id: string) => withToken((token) => uploadsApi.remove(token, id)),
      },
      jobs: {
        enqueue: (noteId: string, kind: Parameters<typeof jobsApi.enqueue>[2]) =>
          withToken((token) => jobsApi.enqueue(token, noteId, kind)),
        get: (id: string) => withToken((token) => jobsApi.get(token, id)),
        forNote: (noteId: string) => withToken((token) => jobsApi.forNote(token, noteId)),
        feedback: (input: Parameters<typeof jobsApi.feedback>[1]) =>
          withToken((token) => jobsApi.feedback(token, input)),
      },
      study: {
        homeSummary: () => withToken(studyApi.homeSummary),
        sets: () => withToken(studyApi.sets),
        quiz: (quizId: string) => withToken((token) => studyApi.quiz(token, quizId)),
        due: (limit: number, aheadDays = 7) =>
          withToken((token) => studyApi.due(token, limit, aheadDays)),
        syncReviews: (logs: ReviewLogInput[]) =>
          withToken((token) => studyApi.syncReviews(token, logs)),
        submitAttempt: (attempt: AttemptInput) =>
          withToken((token) => studyApi.submitAttempt(token, attempt)),
        attempt: (id: string) => withToken((token) => studyApi.attempt(token, id)),
        createCard: (noteId: string, card: Parameters<typeof studyApi.createCard>[2]) =>
          withToken((token) => studyApi.createCard(token, noteId, card)),
        updateCard: (cardId: string, card: Parameters<typeof studyApi.updateCard>[2]) =>
          withToken((token) => studyApi.updateCard(token, cardId, card)),
        deleteCard: (cardId: string) => withToken((token) => studyApi.deleteCard(token, cardId)),
      },
      chat: {
        ask: (input: Parameters<typeof chatApi.ask>[1]) =>
          withToken((token) => chatApi.ask(token, input)),
        messages: (courseId: string) =>
          withToken((token) => chatApi.messages(token, courseId)),
        speech: (blob: Blob) => withToken((token) => chatApi.speech(token, blob)),
      },
    }),
    [withToken],
  );
}

export type ApiClient = ReturnType<typeof useApi>;
