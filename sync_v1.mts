import dotenv from 'dotenv';
import fetch from 'node-fetch';
import fs from 'fs/promises';

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
        identifier
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
        identifier
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

interface ProjectLabelMapping {
  '001 Core Systems': string;
  '002 Core Areas': string;
}

async function loadProjectLabelMappings(): Promise<Record<string, ProjectLabelMapping>> {
  try {
    const data = await fs.readFile('project_label_mappings.json', 'utf8');
    const json = JSON.parse(data);
    return json.PROJECT_LABEL_MAPPING;
  } catch (error) {
    console.error('Error loading project label mappings:', error);
    process.exit(1);
  }
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
      graphqlRequest<{ issueLabels: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Label[] } }>
        (PAGINATED_WORKSPACE_LABELS_QUERY, { after: endCursor })
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
      graphqlRequest<UpdateIssueMutationResponse>(UPDATE_ISSUE_MUTATION,
        { issueId: issue.id, labelIds: labelIds }
      )
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

    const PROJECT_LABEL_MAPPING = await loadProjectLabelMappings();

    console.log('Workspace labels:');
    workspaceLabels.forEach(label => {
      console.log(`- ${label.name} (${label.id})`);
    });

    const labelNameToId = workspaceLabels.reduce<Record<string, string>>((acc, label) => {
      acc[label.name] = label.id;
      return acc;
    }, {});

    const issuesToUpdate = issues.filter(issue => {
      if (!issue.project) {
        console.log(`Skipping issue ${issue.identifier} (${issue.title}): No project assigned`);
        return false;
      }
      const projectMapping = PROJECT_LABEL_MAPPING[issue.project.name];
      if (!projectMapping) {
        console.log(`Skipping issue ${issue.identifier} (${issue.title}): Project "${issue.project.name}" not in mapping`);
        return false;
      }

      const existingLabelNames = new Set(issue.labels.nodes.map(label => label.name));
      const needsUpdate = LABEL_GROUPS.some(group => !existingLabelNames.has(projectMapping[group]));

      if (needsUpdate) {
        console.log(`Issue ${issue.identifier} (${issue.title}) needs update`);
      }

      return needsUpdate;
    });

    console.log(`${issuesToUpdate.length} issues need updating`);

    for (const issue of issuesToUpdate) {
      if (!issue.project) continue;
      const projectMapping = PROJECT_LABEL_MAPPING[issue.project.name];
      if (!projectMapping) continue;

      const existingLabelIds = new Set(issue.labels.nodes.map(label => label.id));
      const newLabelIds = new Set(existingLabelIds);

      for (const group of LABEL_GROUPS) {
        const requiredLabelName = projectMapping[group];
        const requiredLabelId = labelNameToId[requiredLabelName];

        if (requiredLabelId) {
          newLabelIds.add(requiredLabelId);
        } else {
          console.warn(`Required label "${requiredLabelName}" not found in workspace labels`);
        }
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