import { describe, expect, it } from "vitest";
import { objectUrlOf, presignS3Query, signS3Request } from "~/adapters/s3/s3-object-store.js";

// docs/specs/retro-agent.md. The hand-written SigV4 signer must match AWS, or every bucket refuses
// the transcripts. The vector is the "GET Object" example of the AWS Signature Version 4 docs.
describe("the S3 request signer", () => {
  it("signs the AWS GET Object example to the published signature", () => {
    const headers = signS3Request(
      { region: "us-east-1", accessKey: "AKIAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
      {
        method: "GET",
        host: "examplebucket.s3.amazonaws.com",
        path: "/test.txt",
        payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        headers: { Range: "bytes=0-9" },
      },
      new Date("2013-05-24T00:00:00Z"),
    );
    expect(headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("addresses an object path-style under the endpoint path", () => {
    expect(objectUrlOf({ endpoint: "https://minio.example.com/s3/", bucket: "kept" }, "transcripts/t 1/run.txt.gz")).toEqual({
      host: "minio.example.com",
      origin: "https://minio.example.com",
      path: "/s3/kept/transcripts/t%201/run.txt.gz",
    });
  });

  // docs/specs/s3-object-store.md. The presigned GET of an artifact must match AWS query
  // authentication, or every /artifacts redirect fails. The vector is the presigned URL example of
  // the AWS Signature Version 4 docs.
  it("presigns the AWS query authentication example to the published signature", () => {
    const query = presignS3Query(
      { region: "us-east-1", accessKey: "AKIAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
      { method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", expiresSeconds: 86400 },
      new Date("2013-05-24T00:00:00Z"),
    );
    expect(query).toBe(
      "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });
});
