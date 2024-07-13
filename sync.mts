import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const LINEAR_API_KEY = process.env.LINEAR_API_KEY as string;

if (!LINEAR_API_KEY) {
  console.error('LINEAR_API_KEY is not set in the environment variables');
  process.exit(1);
}

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 1000;

const ISSUES_QUERY = `
  query($after: String) {
    issues(first: 50, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        labels {
          nodes {
            id
            name
          }
        }
        project {
          id
          name
        }
        team {
          id
          name
        }
      }
    }
  }
`;


const WORKSPACE_LABELS_QUERY = `
  query($after: String) {
    issueLabels(first: 100, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
      }
    }
  }
`;

const UPDATE_ISSUE_MUTATION = `
  mutation($issueId: String!, $labelIds: [String!]!) {
    issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
      success
      issue {
        id
        title
        labels {
          nodes {
            id
            name
          }
        }
      }
    }
  }
`;

const LABEL_GROUPS = ['001 Core Systems', '002 Core Areas'] as const;
type LabelGroup = typeof LABEL_GROUPS[number];

function inferCoreSystemsLabel(projectIdentifier: string): string {
  if (!projectIdentifier) {
    throw new Error(`Invalid projectIdentifier format: ${projectIdentifier}`);
  }

  const parts = projectIdentifier.split('.');
  if (parts.length < 1) {
    throw new Error(`Invalid projectIdentifier format: ${projectIdentifier}`);
  }

  const systemNumber = parseInt(parts[0].substring(0, 3));
  const lowerBound = Math.floor(systemNumber / 100) * 100;
  const upperBound = lowerBound + 99;
  return `[${lowerBound.toString().padStart(3, '0')}-${upperBound.toString().padStart(3, '0')}]`;
}


function inferCoreAreasLabel(projectIdentifier: string): string {
  if (!projectIdentifier) {
    throw new Error(`Invalid projectIdentifier format: ${projectIdentifier}`);
  }

  const parts = projectIdentifier.split('.');
  if (parts.length < 1) {
    throw new Error(`Invalid projectIdentifier format: ${projectIdentifier}`);
  }

  const areaNumber = parts[0].slice(1, 4);
  return `[${areaNumber}]`;
}

async function fetchWithRetry<T>(operation: () => Promise<T>, attempts = RETRY_ATTEMPTS): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (attempts <= 1) throw error;
    console.log(`Retrying operation. Attempts left: ${attempts - 1}`);
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    return fetchWithRetry(operation, attempts - 1);
  }
}

interface Label {
  id: string;
  name: string;
}

interface Issue {
  id: string;
  title: string;
  identifier: string;
  labels: {
    nodes: Label[];
  };
  project: {
    id: string;
    name: string;
    identifier: string; // Ensure identifier is explicitly typed
  } | null;
  team: {
    id: string;
    name: string;
  };
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface IssuesQueryResponse {
  issues: {
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
    nodes: Issue[];
  };
}

interface WorkspaceLabelsQueryResponse {
  issueLabels: {
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
    nodes: Label[];
  };
}

interface UpdateIssueMutationResponse {
  issueUpdate: {
    success: boolean;
    issue: Issue;
  };
}

async function graphqlRequest<T>(query: string, variables: Record<string, any> = {}): Promise<GraphQLResponse<T>> {
  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': LINEAR_API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });

  const responseData = await response.json() as GraphQLResponse<T>;

  if (!response.ok) {
    console.error('GraphQL request failed:', JSON.stringify(responseData, null, 2));
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  if (responseData.errors) {
    console.error('GraphQL errors:', JSON.stringify(responseData.errors, null, 2));
    throw new Error('GraphQL request failed');
  }

  return responseData;
}

async function fetchAllIssues(): Promise<Issue[]> {
  let issues: Issue[] = [];
  let hasNextPage = true;
  let endCursor: string | null = null;

  while (hasNextPage) {
    const data = await fetchWithRetry(() => graphqlRequest<IssuesQueryResponse>(ISSUES_QUERY, { after: endCursor }));
    if (data.data) {
      issues.push(...data.data.issues.nodes);
      hasNextPage = data.data.issues.pageInfo.hasNextPage;
      endCursor = data.data.issues.pageInfo.endCursor;
    } else {
      throw new Error('Unexpected response format: missing data');
    }
  }

  return issues;
}

async function fetchWorkspaceLabels(): Promise<Label[]> {
  let labels: Label[] = [];
  let hasNextPage = true;
  let endCursor: string | null = null;

  const PAGINATED_WORKSPACE_LABELS_QUERY = `
    query($after: String) {
      issueLabels(first: 100, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          name
        }
      }
    }
  `;

  while (hasNextPage) {
    const data = await fetchWithRetry(() =>
      graphqlRequest<WorkspaceLabelsQueryResponse>(PAGINATED_WORKSPACE_LABELS_QUERY, { after: endCursor })
    );

    if (data.data) {
      labels.push(...data.data.issueLabels.nodes);
      hasNextPage = data.data.issueLabels.pageInfo.hasNextPage;
      endCursor = data.data.issueLabels.pageInfo.endCursor;
    } else {
      throw new Error('Unexpected response format: missing data');
    }
  }

  return labels;
}

async function updateIssue(issue: Issue, labelIds: string[]) {
  try {
    console.log(`Updating issue ${issue.identifier} (${issue.title})`);
    console.log(`Current labels: ${issue.labels.nodes.map(l => l.name).join(', ')}`);
    console.log(`New label IDs: ${labelIds.join(', ')}`);

    const result = await fetchWithRetry(() =>
      graphqlRequest<UpdateIssueMutationResponse>(UPDATE_ISSUE_MUTATION, { issueId: issue.id, labelIds })
    );

    if (result.data?.issueUpdate) {
      if (result.data.issueUpdate.success) {
        const updatedLabels = result.data.issueUpdate.issue.labels.nodes.map(l => l.name).join(', ');
        console.log(`Successfully updated issue ${issue.identifier} (${issue.title})`);
        console.log(`Updated labels: ${updatedLabels}`);
      } else {
        console.error(`Failed to update issue ${issue.identifier} (${issue.title})`);
      }
    } else {
      console.error(`Unexpected response format for issue ${issue.identifier} (${issue.title}):`, JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(`Error updating issue ${issue.identifier} (${issue.title}):`, error);
  }
}

async function syncTasks() {
  try {
    const issues = await fetchAllIssues();
    console.log(`Fetched ${issues.length} issues`);

    const workspaceLabels = await fetchWorkspaceLabels();
    console.log(`Fetched ${workspaceLabels.length} workspace labels`);

    const labelNameToId = workspaceLabels.reduce<Record<string, string>>((acc, label) => {
      acc[label.name] = label.id;
      return acc;
    }, {});

    console.log('Workspace labels:', workspaceLabels.map(label => label.name).join(', '));

    const issuesToUpdate = issues.filter(issue => {
      if (!issue.project || !issue.project.identifier) {
        console.log(`Skipping issue ${issue.identifier} (${issue.title}): No valid project identifier`);
        return false;
      }

      const existingLabelNames = new Set(issue.labels.nodes.map(label => label.name));
      const coreSystemsLabel = inferCoreSystemsLabel(issue.project.identifier);
      const coreAreasLabel = inferCoreAreasLabel(issue.project.identifier);

      const needsUpdate = !existingLabelNames.has(coreSystemsLabel) || !existingLabelNames.has(coreAreasLabel);

      if (needsUpdate) {
        console.log(`Issue ${issue.identifier} (${issue.title}) needs update`);
      }

      return needsUpdate;
    });

    console.log(`${issuesToUpdate.length} issues need updating`);

    for (const issue of issuesToUpdate) {
      if (!issue.project || !issue.project.identifier) continue;

      const existingLabelIds = new Set(issue.labels.nodes.map(label => label.id));
      const newLabelIds = new Set(existingLabelIds);

      const coreSystemsLabel = inferCoreSystemsLabel(issue.project.identifier);
      const coreAreasLabel = inferCoreAreasLabel(issue.project.identifier);

      const coreSystemsLabelId = labelNameToId[coreSystemsLabel];
      const coreAreasLabelId = labelNameToId[coreAreasLabel];

      if (coreSystemsLabelId) {
        newLabelIds.add(coreSystemsLabelId);
      } else {
        console.warn(`Label ID not found for ${coreSystemsLabel}. Make sure it exists in the workspace labels`);
      }

      if (coreAreasLabelId) {
        newLabelIds.add(coreAreasLabelId);
      } else {
        console.warn(`Label ID not found for ${coreAreasLabel}. Make sure it exists in the workspace labels`);
      }

      const labelIdsToUpdate = Array.from(newLabelIds);

      if (labelIdsToUpdate.length !== existingLabelIds.size) {
        await updateIssue(issue, labelIdsToUpdate);
      } else {
        console.log(`No label changes needed for issue ${issue.identifier} (${issue.title})`);
      }
    }

    console.log('Task sync completed successfully');
  } catch (error) {
    console.error('Error syncing tasks:', error);
  }
}

syncTasks().catch(error => console.error('Unhandled error:', error));


syncTasks().catch(error => console.error('Unhandled error:', error));
