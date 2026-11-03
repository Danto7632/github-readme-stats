// @ts-check

import { retryer } from "../common/retryer.js";
import { logger } from "../common/log.js";
import { excludeRepositories } from "../common/envs.js";
import { CustomError, MissingParamError } from "../common/error.js";
import { wrapTextMultiline } from "../common/fmt.js";
import { request } from "../common/http.js";

/**
 * Top languages fetcher object.
 *
 * @param {any} variables Fetcher variables.
 * @param {string} token GitHub token.
 * @returns {Promise<import("axios").AxiosResponse>} Languages fetcher response.
 */
const fetcher = (variables, token) => {
  return request(
    {
      query: `
      query userInfo($login: String!) {
        user(login: $login) {
          # fetch only owner repos & not forks
          repositories(ownerAffiliations: OWNER, isFork: false, first: 100) {
            nodes {
              name
              languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
                edges {
                  size
                  node {
                    color
                    name
                  }
                }
              }
            }
          }
        }
      }
      `,
      variables,
    },
    {
      Authorization: `token ${token}`,
    },
  );
};

const CONTRIBUTED_REPO_FIELDS = `
  nodes {
    name
    nameWithOwner
    languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
      edges {
        size
        node {
          color
          name
        }
      }
    }
    defaultBranchRef {
      target {
        ... on Commit {
          authored: history(author: {id: $id}) {
            totalCount
          }
          history {
            totalCount
          }
        }
      }
    }
  }
`;

/**
 * Contributor info fetcher object.
 *
 * Fetches the user id and the number of owned repositories.
 *
 * @param {any} variables Fetcher variables.
 * @param {string} token GitHub token.
 * @returns {Promise<import("axios").AxiosResponse>} Contributor fetcher response.
 */
const contributorFetcher = (variables, token) => {
  return request(
    {
      query: `
      query userInfo($login: String!) {
        user(login: $login) {
          id
          repositories(ownerAffiliations: OWNER, isFork: false) {
            totalCount
          }
        }
      }
      `,
      variables,
    },
    {
      Authorization: `token ${token}`,
    },
  );
};

/**
 * Organizations fetcher object. Requires the read:org scope.
 *
 * @param {any} variables Fetcher variables.
 * @param {string} token GitHub token.
 * @returns {Promise<import("axios").AxiosResponse>} Organizations fetcher response.
 */
const orgsFetcher = (variables, token) => {
  return request(
    {
      query: `
      query userInfo($login: String!) {
        user(login: $login) {
          organizations(first: 100) {
            nodes {
              login
            }
          }
        }
      }
      `,
      variables,
    },
    {
      Authorization: `token ${token}`,
    },
  );
};

/**
 * User repositories fetcher object (owned or collaborator repositories).
 *
 * @param {any} variables Fetcher variables.
 * @param {string} token GitHub token.
 * @returns {Promise<import("axios").AxiosResponse>} Repositories fetcher response.
 */
const userReposFetcher = (variables, token) => {
  return request(
    {
      query: `
      query userInfo($login: String!, $id: ID!, $affiliation: RepositoryAffiliation!, $first: Int!, $direction: OrderDirection!) {
        user(login: $login) {
          repositories(ownerAffiliations: [$affiliation], isFork: false, first: $first, orderBy: {field: NAME, direction: $direction}) {
            ${CONTRIBUTED_REPO_FIELDS}
          }
        }
      }
      `,
      variables,
    },
    {
      Authorization: `token ${token}`,
    },
  );
};

/**
 * Organization repositories fetcher object.
 *
 * @param {any} variables Fetcher variables.
 * @param {string} token GitHub token.
 * @returns {Promise<import("axios").AxiosResponse>} Repositories fetcher response.
 */
const orgReposFetcher = (variables, token) => {
  return request(
    {
      query: `
      query orgInfo($org: String!, $id: ID!) {
        organization(login: $org) {
          repositories(isFork: false, first: 100) {
            ${CONTRIBUTED_REPO_FIELDS}
          }
        }
      }
      `,
      variables,
    },
    {
      Authorization: `token ${token}`,
    },
  );
};

/**
 * Throw a CustomError if the GraphQL response contains errors.
 *
 * @param {import("axios").AxiosResponse} res GraphQL response.
 */
const throwOnErrors = (res) => {
  if (res.data.errors) {
    logger.error(res.data.errors);
    if (res.data.errors[0].type === "NOT_FOUND") {
      throw new CustomError(
        res.data.errors[0].message || "Could not fetch user.",
        CustomError.USER_NOT_FOUND,
      );
    }
    if (res.data.errors[0].message) {
      throw new CustomError(
        wrapTextMultiline(res.data.errors[0].message, 90, 1)[0],
        res.statusText,
      );
    }
    throw new CustomError(
      "Something went wrong while trying to retrieve the language data using the GraphQL API.",
      CustomError.GRAPHQL_ERROR,
    );
  }
};

/**
 * Fetch every non-fork repository the user committed to, including private
 * and organization repositories the token can read.
 *
 * Language sizes are scaled by the user's share of the default branch commits,
 * so large team repositories count only for the part the user wrote.
 *
 * @param {string} username GitHub username.
 * @returns {Promise<any[]>} Repository nodes shaped like the owner repo query.
 */
const fetchContributedRepoNodes = async (username) => {
  const [userRes, orgsRes] = await Promise.all([
    retryer(contributorFetcher, { login: username }),
    retryer(orgsFetcher, { login: username }),
  ]);
  throwOnErrors(userRes);
  const { id, repositories } = userRes.data.data.user;
  // listing organizations needs the read:org scope, so continue with owned and
  // collaborator repositories when the token lacks it
  if (orgsRes.data.errors) {
    logger.error(orgsRes.data.errors);
  }
  const organizations = orgsRes.data.data?.user?.organizations?.nodes || [];

  // counting authored commits is slow, so split the owned repositories into
  // two halves fetched from both ends of the name order in parallel
  const ownedHalves = [
    { direction: "ASC", first: Math.ceil(repositories.totalCount / 2) },
    { direction: "DESC", first: Math.floor(repositories.totalCount / 2) },
  ].filter((half) => half.first > 0);
  const userRequests = [
    ...ownedHalves.map((half) => ({
      affiliation: "OWNER",
      ...half,
      first: Math.min(half.first, 100),
    })),
    { affiliation: "COLLABORATOR", direction: "ASC", first: 100 },
  ].map((variables) =>
    retryer(userReposFetcher, { login: username, id, ...variables }),
  );
  const orgRequests = organizations.map((org) =>
    retryer(orgReposFetcher, { org: org.login, id }),
  );

  const [userResponses, orgResponses] = await Promise.all([
    Promise.all(userRequests),
    Promise.all(orgRequests),
  ]);

  /** @type {Record<string, any>} */
  const repos = {};
  const addRepos = (nodes) =>
    nodes.forEach((node) => (repos[node.nameWithOwner] = node));
  userResponses.forEach((res) => {
    throwOnErrors(res);
    addRepos(res.data.data.user.repositories.nodes);
  });
  orgResponses.forEach((res) => {
    // skip organizations the token cannot read instead of failing the card
    if (res.data.errors) {
      logger.error(res.data.errors);
      return;
    }
    addRepos(res.data.data.organization?.repositories.nodes || []);
  });

  return Object.values(repos)
    .map((repo) => {
      const commits = repo.defaultBranchRef?.target;
      const authored = commits?.authored.totalCount || 0;
      const share = authored
        ? Math.min(1, authored / commits.history.totalCount)
        : 0;
      return {
        name: repo.name,
        languages: {
          edges: repo.languages.edges.map((edge) => ({
            ...edge,
            size: edge.size * share,
          })),
        },
        share,
      };
    })
    .filter((repo) => repo.share > 0);
};

/**
 * @typedef {import("./types").TopLangData} TopLangData Top languages data.
 */

/**
 * Fetch top languages for a given username.
 *
 * @param {string} username GitHub username.
 * @param {string[]} exclude_repo List of repositories to exclude.
 * @param {number} size_weight Weightage to be given to size.
 * @param {number} count_weight Weightage to be given to count.
 * @param {boolean} include_contributed Count every repository the user committed to (incl. organizations), weighted by commit share.
 * @returns {Promise<TopLangData>} Top languages data.
 */
const fetchTopLanguages = async (
  username,
  exclude_repo = [],
  size_weight = 1,
  count_weight = 0,
  include_contributed = false,
) => {
  if (!username) {
    throw new MissingParamError(["username"]);
  }

  let repoNodes;
  if (include_contributed) {
    repoNodes = await fetchContributedRepoNodes(username);
  } else {
    const res = await retryer(fetcher, { login: username });
    throwOnErrors(res);
    repoNodes = res.data.data.user.repositories.nodes;
  }
  /** @type {Record<string, boolean>} */
  let repoToHide = {};
  const allExcludedRepos = [...exclude_repo, ...excludeRepositories];

  // populate repoToHide map for quick lookup
  // while filtering out
  if (allExcludedRepos) {
    allExcludedRepos.forEach((repoName) => {
      repoToHide[repoName] = true;
    });
  }

  // filter out repositories to be hidden
  repoNodes = repoNodes
    .sort((a, b) => b.size - a.size)
    .filter((name) => !repoToHide[name.name]);

  let repoCount = 0;

  repoNodes = repoNodes
    .filter((node) => node.languages.edges.length > 0)
    // flatten the list of language nodes
    .reduce((acc, curr) => curr.languages.edges.concat(acc), [])
    .reduce((acc, prev) => {
      // get the size of the language (bytes)
      let langSize = prev.size;

      // if we already have the language in the accumulator
      // & the current language name is same as previous name
      // add the size to the language size and increase repoCount.
      if (acc[prev.node.name] && prev.node.name === acc[prev.node.name].name) {
        langSize = prev.size + acc[prev.node.name].size;
        repoCount += 1;
      } else {
        // reset repoCount to 1
        // language must exist in at least one repo to be detected
        repoCount = 1;
      }
      return {
        ...acc,
        [prev.node.name]: {
          name: prev.node.name,
          color: prev.node.color,
          size: langSize,
          count: repoCount,
        },
      };
    }, {});

  Object.keys(repoNodes).forEach((name) => {
    // comparison index calculation
    repoNodes[name].size =
      Math.pow(repoNodes[name].size, size_weight) *
      Math.pow(repoNodes[name].count, count_weight);
  });

  const topLangs = Object.keys(repoNodes)
    .sort((a, b) => repoNodes[b].size - repoNodes[a].size)
    .reduce((result, key) => {
      result[key] = repoNodes[key];
      return result;
    }, {});

  return topLangs;
};

export { fetchTopLanguages };
export default fetchTopLanguages;
