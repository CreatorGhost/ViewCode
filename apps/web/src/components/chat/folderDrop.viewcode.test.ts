import { describe, expect, it } from "vite-plus/test";

import { localFileAttachmentPath } from "./folderDrop";

const movie = new File(["x"], "movie.mp4", { type: "video/mp4" });
const getPathForFile = () => "/Users/me/Movies/movie.mp4";

// ViewCode guard: on the local environment a file goes in as its disk path, so a file
// larger than the upload limit (a whole movie) still reaches the agent.
describe("localFileAttachmentPath (ViewCode)", () => {
  it("uses the disk path for a local file", () => {
    expect(
      localFileAttachmentPath({ file: movie, isImage: false, target: "local", getPathForFile }),
    ).toBe("/Users/me/Movies/movie.mp4");
  });

  it("still uploads images so the model can see them", () => {
    expect(
      localFileAttachmentPath({ file: movie, isImage: true, target: "local", getPathForFile }),
    ).toBeNull();
  });

  it("uploads on a remote environment, where the agent can't read this disk", () => {
    expect(
      localFileAttachmentPath({ file: movie, isImage: false, target: "remote", getPathForFile }),
    ).toBeNull();
  });

  it("uploads a file with no disk path, such as a paste or a browser pick", () => {
    expect(
      localFileAttachmentPath({
        file: movie,
        isImage: false,
        target: "local",
        getPathForFile: () => "",
      }),
    ).toBeNull();
    expect(
      localFileAttachmentPath({
        file: movie,
        isImage: false,
        target: "local",
        getPathForFile: undefined,
      }),
    ).toBeNull();
  });
});
