export interface LinkMessage {
	type: "link";
	from: string;
	reply?: boolean;
}
