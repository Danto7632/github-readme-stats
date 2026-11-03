import { afterEach, describe, expect, it } from "@jest/globals";
import "@testing-library/jest-dom";
import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import { fetchTopLanguages } from "../src/fetchers/top-languages.js";

const mock = new MockAdapter(axios);

afterEach(() => {
  mock.reset();
});

const data_langs = {
  data: {
    user: {
      repositories: {
        nodes: [
          {
            name: "test-repo-1",
            languages: {
              edges: [{ size: 100, node: { color: "#0f0", name: "HTML" } }],
            },
          },
          {
            name: "test-repo-2",
            languages: {
              edges: [{ size: 100, node: { color: "#0f0", name: "HTML" } }],
            },
          },
          {
            name: "test-repo-3",
            languages: {
              edges: [
                { size: 100, node: { color: "#0ff", name: "javascript" } },
              ],
            },
          },
          {
            name: "test-repo-4",
            languages: {
              edges: [
                { size: 100, node: { color: "#0ff", name: "javascript" } },
              ],
            },
          },
        ],
      },
    },
  },
};

const error = {
  errors: [
    {
      type: "NOT_FOUND",
      path: ["user"],
      locations: [],
      message: "Could not resolve to a User with the login of 'noname'.",
    },
  ],
};

const contributedRepo = (name, language, size, authored, total) => ({
  name,
  nameWithOwner: `owner/${name}`,
  languages: {
    edges: [{ size, node: { color: "#000", name: language } }],
  },
  defaultBranchRef: {
    target: {
      authored: { totalCount: authored },
      history: { totalCount: total },
    },
  },
});

const mockContributedRepos = (orgsResponse) => {
  mock.onPost("https://api.github.com/graphql").reply((config) => {
    const { query, variables } = JSON.parse(config.data);
    if (query.includes("organizations(")) {
      return [200, orgsResponse];
    }
    if (query.includes("organization(login")) {
      return [
        200,
        {
          data: {
            organization: {
              repositories: {
                nodes: [contributedRepo("org-repo", "Kotlin", 200, 1, 2)],
              },
            },
          },
        },
      ];
    }
    if (query.includes("$affiliation")) {
      const nodes =
        variables.affiliation === "OWNER"
          ? [
              contributedRepo("own-repo", "TypeScript", 100, 10, 10),
              contributedRepo("untouched-repo", "HTML", 999, 0, 5),
            ]
          : [contributedRepo("team-repo", "Java", 400, 1, 4)];
      return [200, { data: { user: { repositories: { nodes } } } }];
    }
    return [
      200,
      { data: { user: { id: "U_1", repositories: { totalCount: 1 } } } },
    ];
  });
};

describe("FetchTopLanguages", () => {
  it("should count contributed repositories weighted by the user's commit share", async () => {
    mockContributedRepos({
      data: { user: { organizations: { nodes: [{ login: "org" }] } } },
    });

    const repo = await fetchTopLanguages("anuraghazra", [], 1, 0, true);
    expect(repo).toStrictEqual({
      TypeScript: { color: "#000", count: 1, name: "TypeScript", size: 100 },
      Java: { color: "#000", count: 1, name: "Java", size: 100 },
      Kotlin: { color: "#000", count: 1, name: "Kotlin", size: 100 },
    });
  });

  it("should skip organizations when the token cannot list them", async () => {
    mockContributedRepos({
      errors: [{ type: "INSUFFICIENT_SCOPES", message: "read:org required" }],
    });

    const repo = await fetchTopLanguages("anuraghazra", [], 1, 0, true);
    expect(Object.keys(repo).sort()).toStrictEqual(["Java", "TypeScript"]);
  });

  it("should fetch correct language data while using the new calculation", async () => {
    mock.onPost("https://api.github.com/graphql").reply(200, data_langs);

    let repo = await fetchTopLanguages("anuraghazra", [], 0.5, 0.5);
    expect(repo).toStrictEqual({
      HTML: {
        color: "#0f0",
        count: 2,
        name: "HTML",
        size: 20.000000000000004,
      },
      javascript: {
        color: "#0ff",
        count: 2,
        name: "javascript",
        size: 20.000000000000004,
      },
    });
  });

  it("should fetch correct language data while excluding the 'test-repo-1' repository", async () => {
    mock.onPost("https://api.github.com/graphql").reply(200, data_langs);

    let repo = await fetchTopLanguages("anuraghazra", ["test-repo-1"]);
    expect(repo).toStrictEqual({
      HTML: {
        color: "#0f0",
        count: 1,
        name: "HTML",
        size: 100,
      },
      javascript: {
        color: "#0ff",
        count: 2,
        name: "javascript",
        size: 200,
      },
    });
  });

  it("should fetch correct language data while using the old calculation", async () => {
    mock.onPost("https://api.github.com/graphql").reply(200, data_langs);

    let repo = await fetchTopLanguages("anuraghazra", [], 1, 0);
    expect(repo).toStrictEqual({
      HTML: {
        color: "#0f0",
        count: 2,
        name: "HTML",
        size: 200,
      },
      javascript: {
        color: "#0ff",
        count: 2,
        name: "javascript",
        size: 200,
      },
    });
  });

  it("should rank languages by the number of repositories they appear in", async () => {
    mock.onPost("https://api.github.com/graphql").reply(200, data_langs);

    let repo = await fetchTopLanguages("anuraghazra", [], 0, 1);
    expect(repo).toStrictEqual({
      HTML: {
        color: "#0f0",
        count: 2,
        name: "HTML",
        size: 2,
      },
      javascript: {
        color: "#0ff",
        count: 2,
        name: "javascript",
        size: 2,
      },
    });
  });

  it("should throw specific error when user not found", async () => {
    mock.onPost("https://api.github.com/graphql").reply(200, error);

    await expect(fetchTopLanguages("anuraghazra")).rejects.toThrow(
      "Could not resolve to a User with the login of 'noname'.",
    );
  });

  it("should throw other errors with their message", async () => {
    mock.onPost("https://api.github.com/graphql").reply(200, {
      errors: [{ message: "Some test GraphQL error" }],
    });

    await expect(fetchTopLanguages("anuraghazra")).rejects.toThrow(
      "Some test GraphQL error",
    );
  });

  it("should throw error with specific message when error does not contain message property", async () => {
    mock.onPost("https://api.github.com/graphql").reply(200, {
      errors: [{ type: "TEST" }],
    });

    await expect(fetchTopLanguages("anuraghazra")).rejects.toThrow(
      "Something went wrong while trying to retrieve the language data using the GraphQL API.",
    );
  });
});
