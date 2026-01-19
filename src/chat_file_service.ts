import * as fs from "fs";
import { ChatFileChunk, ChatMessageService } from "./chat_message_service";
import * as path from "path";
export interface ChatFileMetadata {
    ip: string;
    port: number;
    username: string;
    path: string;
}

export class ChatFileService {
    private readonly chunkSize: number = 1024;
    private fds: Map<string, number> = new Map();
    rootPath: string;
    constructor(rootPath: string) {
        this.rootPath = rootPath;
        fs.mkdirSync(`${this.rootPath}/files`, { recursive: true });
    }

    public download(file: ChatFileMetadata, messageService: ChatMessageService): Promise<boolean> {
        const dirname = path.dirname(file.path);
        const filename = path.basename(file.path);
        const targetPath = `${this.rootPath}/${file.ip}_${file.port}/${dirname}/${filename}`;
        if (fs.existsSync(targetPath)) {
            // TODO: 文件已经存在时进行校验
            // messageService.sendCheckMessage(file);
        } else {
            // 文件不存在
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, "");
            this.fds.set(targetPath, fs.openSync(targetPath, "r+"));
            messageService.sendFileMessage(file);
        }
        return Promise.resolve(true);
    }

    public saveChunk(value: string | undefined, chunk: ChatFileChunk | undefined, ip: string, port: number) {
        // 保存文件
        if (!value || !chunk) {
            return;
        }
        const filePath = path.join(this.rootPath, `${ip}_${port}/$/${value}`);
        if (this.fds.has(filePath)) {
            const fd = this.fds.get(filePath);
            if (!fd) return;
            fs.writeSync(fd, chunk.data, 0, chunk.data.length, chunk.index * this.chunkSize);
            if (chunk.finish) {
                fs.closeSync(fd);
                this.fds.delete(filePath);
            }
        }
    }
}