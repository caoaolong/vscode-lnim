import { Transform, TransformCallback } from "stream";

export class FileChunkTransform extends Transform {

    private header: string;

    constructor(header: string) {
        super();
        this.header = header;
    }

    _transform(chunk: any, _: BufferEncoding, callback: TransformCallback): void {
        this.push(Buffer.from(this.header, "hex"));
        this.push(chunk);
        callback();
    }
}