/**
 * Every GraphQL document `Github` sends, in one place.
 *
 * The owner-scoped ones all go through `repositoryOwner`, which resolves a login
 * to whichever of User/Organization holds it — Github gives the two a single
 * namespace, so the login alone is unambiguous and the caller never has to say
 * which kind it is. Both implement `ProjectV2Owner`, so one query serves user-
 * and org-owned projects alike.
 */

/** Field ids and status option ids: what a run needs to write to the project. */
export const PROJECT_META_QUERY = /* GraphQL */ `
  query ($login: String!, $number: Int!) {
    repositoryOwner(login: $login) {
      ... on ProjectV2Owner {
        projectV2(number: $number) {
          id
          public
          fields(first: 100) {
            nodes {
              __typename
              ... on ProjectV2FieldCommon {
                id
                name
                dataType
              }
              ... on ProjectV2SingleSelectField {
                id
                name
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    }
  }
`;

/** Project items matching a filter, narrowed to the issues ramonda can pick up. */
export const PROJECT_ITEMS_QUERY = /* GraphQL */ `
  query ($login: String!, $number: Int!, $q: String!, $first: Int!) {
    repositoryOwner(login: $login) {
      ... on ProjectV2Owner {
        projectV2(number: $number) {
          items(first: $first, query: $q) {
            nodes {
              id
              content {
                __typename
                ... on Issue {
                  number
                  title
                  body
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * The same project as `PROJECT_META_QUERY`, read for `setup-project` rather than
 * for a run: identity plus every field with its options *and their colors*, which
 * is what an option append has to send back unchanged.
 *
 * The workflows come along because some of Github's built-in ones fight ramonda
 * and the people on the board for the `Status` field — see
 * `CONFLICTING_WORKFLOWS` — and the plan has to know which of them this project
 * carries before it decides anything. Read here rather
 * than in a query of its own so the whole diff is still built from one answer.
 */
export const PROJECT_SHAPE_QUERY = /* GraphQL */ `
  query ($login: String!, $number: Int!) {
    repositoryOwner(login: $login) {
      ... on ProjectV2Owner {
        projectV2(number: $number) {
          id
          number
          title
          url
          public
          workflows(first: 50) {
            nodes {
              id
              name
            }
          }
          fields(first: 100) {
            nodes {
              __typename
              ... on ProjectV2FieldCommon {
                id
                name
                dataType
              }
              ... on ProjectV2SingleSelectField {
                id
                name
                options {
                  id
                  name
                  color
                  description
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const OWNER_ID_QUERY = /* GraphQL */ `
  query ($login: String!) {
    repositoryOwner(login: $login) {
      id
    }
  }
`;

export const REPOSITORY_ID_QUERY = /* GraphQL */ `
  query ($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      id
    }
  }
`;

/**
 * `createProjectV2` takes no visibility argument, so `public` is read back rather
 * than set: a new project is private by default, and asking confirms that rather
 * than trusting it. `SET_PROJECT_PRIVATE_MUTATION` fixes the one case where it
 * is not.
 */
export const CREATE_PROJECT_MUTATION = /* GraphQL */ `
  mutation ($ownerId: ID!, $title: String!, $repositoryId: ID) {
    createProjectV2(input: { ownerId: $ownerId, title: $title, repositoryId: $repositoryId }) {
      projectV2 {
        id
        number
        url
        public
      }
    }
  }
`;

export const SET_PROJECT_PRIVATE_MUTATION = /* GraphQL */ `
  mutation ($projectId: ID!) {
    updateProjectV2(input: { projectId: $projectId, public: false }) {
      projectV2 {
        public
      }
    }
  }
`;

export const CREATE_TEXT_FIELD_MUTATION = /* GraphQL */ `
  mutation ($projectId: ID!, $name: String!) {
    createProjectV2Field(input: { projectId: $projectId, dataType: TEXT, name: $name }) {
      projectV2Field {
        ... on ProjectV2Field {
          id
        }
      }
    }
  }
`;

export const CREATE_SELECT_FIELD_MUTATION = /* GraphQL */ `
  mutation ($projectId: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
    createProjectV2Field(
      input: { projectId: $projectId, dataType: SINGLE_SELECT, name: $name, singleSelectOptions: $options }
    ) {
      projectV2Field {
        ... on ProjectV2SingleSelectField {
          id
        }
      }
    }
  }
`;

export const UPDATE_SELECT_FIELD_MUTATION = /* GraphQL */ `
  mutation ($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
    updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) {
      projectV2Field {
        ... on ProjectV2SingleSelectField {
          id
        }
      }
    }
  }
`;

/**
 * Deletion rather than a disable, because Github offers no other lever: the
 * schema carries `deleteProjectV2Workflow` and no mutation that would turn one
 * off. A workflow deleted here can be written again by hand in the project's
 * settings, which is the way back for anyone who wants it.
 */
export const DELETE_PROJECT_WORKFLOW_MUTATION = /* GraphQL */ `
  mutation ($workflowId: ID!) {
    deleteProjectV2Workflow(input: { workflowId: $workflowId }) {
      deletedWorkflowId
    }
  }
`;

export const SET_ITEM_TEXT_MUTATION = /* GraphQL */ `
  mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: String!) {
    updateProjectV2ItemFieldValue(
      input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { text: $value } }
    ) {
      projectV2Item {
        id
      }
    }
  }
`;

export const CLEAR_ITEM_FIELD_MUTATION = /* GraphQL */ `
  mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
    clearProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }) {
      projectV2Item {
        id
      }
    }
  }
`;

export const SET_ITEM_SELECT_MUTATION = /* GraphQL */ `
  mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(
      input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }
    ) {
      projectV2Item {
        id
      }
    }
  }
`;

/** The same read for a single-select, so the status write-then-confirm can check itself. */
export const READ_ITEM_SELECT_QUERY = /* GraphQL */ `
  query ($itemId: ID!) {
    node(id: $itemId) {
      ... on ProjectV2Item {
        fieldValues(first: 100) {
          nodes {
            ... on ProjectV2ItemFieldSingleSelectValue {
              optionId
              field {
                ... on ProjectV2FieldCommon {
                  id
                }
              }
            }
          }
        }
      }
    }
  }
`;
