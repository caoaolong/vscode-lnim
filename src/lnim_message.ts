export interface LinkMessage {
  type: "link";
  from: string;
  linkType: "request" | "reply";
}
