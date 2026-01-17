import * as fs from "fs";

const filepath = "./src/test/data/test.png";
const outputPath = "./src/test/data/output.png";
const blockSize = 1024;

const stat = fs.statSync(filepath);
console.log(stat.size);

const start = new Date().getTime();

const fd = fs.openSync(filepath, "r");

fs.writeFileSync(outputPath, ""); // 清空文件
const ofd = fs.openSync(outputPath, "r+");
const buffer = Buffer.alloc(blockSize);
const blockCount = Math.ceil(stat.size / blockSize);

const promises: Promise<void>[] = [];

for (let i = 0; i < blockCount; i++) {
  promises.push(
    new Promise((resolve) => {
      const position = i * blockSize;
      const nbytes = fs.readSync(fd, buffer, 0, blockSize, position);
      fs.writeSync(ofd, buffer, 0, nbytes, position);
      console.log(`第${i + 1}次拷贝字节数: ${nbytes}, 位置: ${position}`);
      resolve();
    })
  );
}

Promise.all(promises).then(() => {
  fs.closeSync(ofd);
  fs.closeSync(fd);
	const stop = new Date().getTime();
  console.log(`所有数据块拷贝完成,耗时: ${stop - start} ms`);
});
