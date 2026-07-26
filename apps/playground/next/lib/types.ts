export interface Comment {
  id: string;
  author: string;
  /** Already HTML-escaped by the server, which is what makes it safe to render as markup. */
  content: string;
  createdAt: string;
}

export interface CommentsResponse {
  comments: Comment[];
  /** Which Redis the guard is talking to; every result has to be read in that light. */
  backend: string;
}
