import { defineConfig } from "@effect/graphql-generator/Config";

// `schema/github.graphql` is github.com's public schema
// (https://docs.github.com/public/fpt/schema.docs.graphql). Enterprise Server lacks some of its
// fields, such as pull request stacks, and rejects a document naming them even under
// `@include(if: false)`, so other hosts get the stack-free documents in pullRequestEnterprise.graphql.
export default defineConfig({
  schema: "./schema/github.graphql",
  documents: ["src/**/*.graphql"],
  scalars: {
    GitObjectID: "effect/Schema#String",
    // A fully qualified ref name such as `refs/heads/main`.
    GitRefname: "effect/Schema#String",
    // Kept as GitHub sends it: callers compare these strings with other reads of the same field.
    DateTime: "effect/Schema#String",
  },
});
