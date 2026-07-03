FROM python:3.11-slim

RUN apt-get update && apt-get install -y git tmux curl asciinema jq nodejs npm && rm -rf /var/lib/apt/lists/*

# Install JupyterHub + JupyterLab + jupyter-mcp-server (as server extension)
RUN pip install jupyterhub "jupyterlab==4.4.1" "jupyter-mcp-server>=0.15.0" \
    jupyter-server-fileid \
    ipykernel nbformat nbconvert numpy scikit-learn

# Install configurable-http-proxy (required by JupyterHub)
RUN npm install -g configurable-http-proxy

# ── Baseline specification (natural language only, no code) ─
COPY <<'EOF' /app/baseline_spec.md
# Baseline Methods Specification

## Overview
We have tested our proposed method (Adaptive Weighted Ensemble) and
recorded results in the research notebook. Now we need to evaluate
5 standard baseline methods for comparison.

Each baseline should be implemented using the same training and
evaluation pipeline already set up in the notebook.

## Baselines

### Baseline 1: Simple Average Ensemble
Train 5 Decision Tree classifiers (max_depth=3, random_state=0..4).
Average their predicted probabilities with equal weight.
Predict the class with the highest averaged probability.

### Baseline 2: Single Decision Tree
A single DecisionTreeClassifier with max_depth=5 and random_state=42.
No ensembling — just one tree.

### Baseline 3: Random Forest
A RandomForestClassifier with 100 estimators, max_depth=6, and
random_state=42. Use sklearn's built-in implementation.

### Baseline 4: Majority Voting Ensemble
Train 5 Decision Tree classifiers with varying max_depth (3,4,5,6,7)
and random_state=0..4. For each test sample, each tree votes for a
class. Return the class with the most votes (hard voting).

### Baseline 5: Weighted Voting (Validation Accuracy)
Train 5 Decision Tree classifiers (max_depth=3..7, random_state=0..4).
Compute each tree's accuracy on a 20% validation split of the training
data. Weight each tree's vote by its validation accuracy. Return the
class with the highest weighted vote.

## Instructions
- Implement each baseline and run it through the existing pipeline
- Record accuracy, F1 score, and training time for every baseline
- After all 5 baselines, add a final comparison cell showing all
  methods side by side (our method + 5 baselines)
EOF

RUN mkdir -p /app/research

# ── Generate dataset file (loaded from file, not generated inline) ──
COPY <<'GENDATA' /tmp/generate_data.py
import numpy as np
from sklearn.datasets import make_classification
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler, PolynomialFeatures

# Generate base dataset
X, y = make_classification(
    n_samples=2000, n_features=20, n_informative=15,
    n_redundant=3, n_classes=4, n_clusters_per_class=2,
    random_state=42, class_sep=1.2
)

# Train/test split
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.3, random_state=42, stratify=y
)

# Save raw data as .npz
np.savez('/app/research/experiment_data.npz',
         X_train=X_train, X_test=X_test,
         y_train=y_train, y_test=y_test)
print("Dataset saved")
GENDATA
RUN python /tmp/generate_data.py && rm /tmp/generate_data.py

# ── Research notebook with proposed method ──────────────────
COPY <<'PYSCRIPT' /tmp/create_notebook.py
import nbformat

nb = nbformat.v4.new_notebook()

# Cell 0: Title (markdown)
nb.cells.append(nbformat.v4.new_markdown_cell(
    "# Ensemble Method Experiment\n\n"
    "## Proposed Method: Adaptive Weighted Ensemble\n\n"
    "This notebook implements and evaluates our proposed Adaptive Weighted Ensemble method.\n"
    "The method learns optimal per-model weights through gradient descent on a validation set."
))

# Cell 1: Imports, Data Loading & Preprocessing Pipeline
cell1_code = '''\
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, f1_score, classification_report
from sklearn.preprocessing import StandardScaler, PolynomialFeatures
from sklearn.feature_selection import SelectKBest, f_classif
import time
import warnings
warnings.filterwarnings('ignore')

# ── Load dataset from file ──
data = np.load('/app/research/experiment_data.npz')
X_train_raw, X_test_raw = data['X_train'], data['X_test']
y_train, y_test = data['y_train'], data['y_test']

# ── Feature Engineering Pipeline ──
# Step 1: Standardize
scaler = StandardScaler()
X_train_scaled = scaler.fit_transform(X_train_raw)
X_test_scaled = scaler.transform(X_test_raw)

# Step 2: Polynomial interaction features (degree=2, interaction only)
poly = PolynomialFeatures(degree=2, interaction_only=True, include_bias=False)
X_train_poly = poly.fit_transform(X_train_scaled)
X_test_poly = poly.transform(X_test_scaled)

# Step 3: Feature selection — keep top 50 features
selector = SelectKBest(f_classif, k=50)
X_train_feat = selector.fit_transform(X_train_poly, y_train)
X_test_feat = selector.transform(X_test_poly)

n_classes = len(np.unique(y_train))

print(f'Training set: {X_train_raw.shape[0]} samples')
print(f'Test set: {X_test_raw.shape[0]} samples')
print(f'Raw features: {X_train_raw.shape[1]}')
print(f'Engineered features: {X_train_feat.shape[1]}')
print(f'Classes: {n_classes}')'''

cell1 = nbformat.v4.new_code_cell(cell1_code)
cell1.outputs = [nbformat.v4.new_output(
    output_type='stream', name='stdout',
    text=('Training set: 1400 samples\n'
          'Test set: 600 samples\n'
          'Raw features: 20\n'
          'Engineered features: 50\n'
          'Classes: 4\n')
)]
cell1.execution_count = 1
nb.cells.append(cell1)

# Cell 2: Model Implementation + Training
# This is where the agent replaces the model for each baseline.
# It must produce a `model` object with .predict() and .predict_proba()
cell2_code = '''\
# ============================================================
# Model Implementation & Training
# ============================================================
# This cell defines and trains the current model.
#
# Contract:
# - Must produce a trained `model` object with .predict(X) method
# - Must set `method_name` string for the evaluation cell
# - Uses X_train_feat, y_train from the preprocessing cell above
# ============================================================

start_time = time.time()

# ---- MODEL IMPLEMENTATION START ----
from sklearn.tree import DecisionTreeClassifier

class AdaptiveWeightedEnsemble:
    """Our proposed method: learns per-model weights via gradient descent."""

    def __init__(self, n_models=5, n_iterations=200, learning_rate=0.01,
                 temperature=1.5, entropy_reg=0.1):
        self.n_models = n_models
        self.n_iterations = n_iterations
        self.learning_rate = learning_rate
        self.temperature = temperature
        self.entropy_reg = entropy_reg
        self.weights = None
        self.base_models = []
        self.training_history = []

    def _softmax(self, x):
        e_x = np.exp((x - np.max(x)) / self.temperature)
        return e_x / e_x.sum()

    def _entropy(self, w):
        w_clipped = np.clip(w, 1e-10, 1.0)
        return -np.sum(w_clipped * np.log(w_clipped))

    def fit(self, X_train, y_train):
        X_tr, X_val, y_tr, y_val = train_test_split(
            X_train, y_train, test_size=0.2, random_state=42
        )
        self.base_models = []
        configs = [
            {'max_depth': 3, 'min_samples_leaf': 5},
            {'max_depth': 5, 'min_samples_leaf': 3},
            {'max_depth': 7, 'min_samples_leaf': 2},
            {'max_depth': 4, 'min_samples_leaf': 10},
            {'max_depth': 6, 'min_samples_leaf': 1},
        ]
        for i, cfg in enumerate(configs[:self.n_models]):
            model = DecisionTreeClassifier(random_state=i, **cfg)
            model.fit(X_tr, y_tr)
            self.base_models.append(model)

        val_probas = np.array([m.predict_proba(X_val) for m in self.base_models])
        raw_weights = np.zeros(self.n_models)
        self.training_history = []

        for iteration in range(self.n_iterations):
            w = self._softmax(raw_weights)
            ensemble_proba = np.tensordot(w, val_probas, axes=([0], [0]))
            n_classes_local = val_probas.shape[2]
            y_onehot = np.eye(n_classes_local)[y_val]
            loss = -np.mean(np.sum(y_onehot * np.log(np.clip(ensemble_proba, 1e-10, 1.0)), axis=1))
            loss -= self.entropy_reg * self._entropy(w)
            self.training_history.append(loss)

            grad = np.zeros(self.n_models)
            eps = 1e-5
            for j in range(self.n_models):
                raw_weights[j] += eps
                w_plus = self._softmax(raw_weights)
                ens_plus = np.tensordot(w_plus, val_probas, axes=([0], [0]))
                loss_plus = -np.mean(np.sum(y_onehot * np.log(np.clip(ens_plus, 1e-10, 1.0)), axis=1))
                loss_plus -= self.entropy_reg * self._entropy(w_plus)
                grad[j] = (loss_plus - loss) / eps
                raw_weights[j] -= eps

            raw_weights -= self.learning_rate * grad

        self.weights = self._softmax(raw_weights)
        return self

    def predict_proba(self, X):
        probas = np.array([m.predict_proba(X) for m in self.base_models])
        return np.tensordot(self.weights, probas, axes=([0], [0]))

    def predict(self, X):
        return np.argmax(self.predict_proba(X), axis=1)

model = AdaptiveWeightedEnsemble(n_models=5, n_iterations=200,
                                  learning_rate=0.01, temperature=1.5,
                                  entropy_reg=0.1)
model.fit(X_train_feat, y_train)
# ---- MODEL IMPLEMENTATION END ----

train_time = time.time() - start_time
method_name = "Adaptive Weighted Ensemble"
print(f"[TRAINED] {method_name} in {train_time:.2f}s")'''

cell2 = nbformat.v4.new_code_cell(cell2_code)
cell2.outputs = [nbformat.v4.new_output(
    output_type='stream', name='stdout',
    text='[TRAINED] Adaptive Weighted Ensemble in 0.20s\n'
)]
cell2.execution_count = 2
nb.cells.append(cell2)

# Cell 3: Evaluation Pipeline (separate cell — reads `model` and `method_name` from Cell 2)
cell3_code = '''\
# ============================================================
# Evaluation Pipeline
# ============================================================
# This cell evaluates the model trained above. Run after each
# model training cell to get results.
# Uses: model, method_name, train_time (from model training cell)
#       X_test_feat, y_test (from preprocessing cell)
# ============================================================

# Test set evaluation
y_pred = model.predict(X_test_feat)
accuracy = accuracy_score(y_test, y_pred)
f1 = f1_score(y_test, y_pred, average='weighted')

print(f"{method_name} - Results")
print("=" * 60)
print(f"Accuracy: {accuracy:.4f}")
print(f"F1 Score: {f1:.4f}")
print(f"Training Time: {train_time:.2f}s")
print()
print(classification_report(y_test, y_pred))'''

cell3 = nbformat.v4.new_code_cell(cell3_code)
cell3.outputs = [nbformat.v4.new_output(
    output_type='stream', name='stdout',
    text=('Adaptive Weighted Ensemble - Results\n'
          '============================================================\n'
          'Accuracy: 0.6217\n'
          'F1 Score: 0.6208\n'
          'Training Time: 0.20s\n'
          '\n'
          '              precision    recall  f1-score   support\n'
          '\n'
          '           0       0.66      0.66      0.66       150\n'
          '           1       0.62      0.52      0.57       150\n'
          '           2       0.66      0.63      0.64       151\n'
          '           3       0.56      0.68      0.61       149\n'
          '\n'
          '    accuracy                           0.62       600\n'
          '   macro avg       0.63      0.62      0.62       600\n'
          'weighted avg       0.63      0.62      0.62       600\n')
)]
cell3.execution_count = 3
nb.cells.append(cell3)

with open('/app/research/experiment.ipynb', 'w') as f:
    nbformat.write(nb, f)

print("Notebook created successfully")
PYSCRIPT

RUN python /tmp/create_notebook.py && rm /tmp/create_notebook.py

# ── JupyterHub configuration ─────────────────────────────
COPY <<'HUBCFG' /app/jupyterhub_config.py
c = get_config()

c.JupyterHub.spawner_class = 'simple'
c.JupyterHub.ip = '0.0.0.0'
c.JupyterHub.port = 9010

c.Spawner.environment = {
    'JUPYTERHUB_ALLOW_TOKEN_IN_URL': '1',
}

c.Spawner.args = [
    '--ServerApp.jpserver_extensions={"jupyter_mcp_server": True}',
    '--allow-root',
]

c.JupyterHub.authenticator_class = 'dummy'
c.DummyAuthenticator.password = 'admin'
c.Authenticator.admin_users = {'admin'}

c.JupyterHub.api_tokens = {
    'mcp-token-tbench-2024': 'admin',
}

c.Spawner.notebook_dir = '/app'
HUBCFG

# ── JupyterHub startup script ───────────────────────────
COPY <<'MCP' /app/start_mcp.sh
#!/bin/bash
set -e

echo "127.0.0.1 jupyter.internal" >> /etc/hosts

API_TOKEN="mcp-token-tbench-2024"

echo "Starting JupyterHub..."
jupyterhub -f /app/jupyterhub_config.py &

echo "Waiting for Hub API..."
for i in $(seq 1 60); do
    CODE=$(curl -s -o /dev/null -w "%{http_code}" \
        -H "Authorization: token $API_TOKEN" \
        http://localhost:9010/hub/api/ 2>/dev/null || echo "000")
    if [ "$CODE" = "200" ]; then
        echo "JupyterHub API ready on port 9010"
        break
    fi
    sleep 1
done

echo "Spawning single-user server..."
curl -s -X POST http://localhost:9010/hub/api/users/admin/server \
    -H "Authorization: token $API_TOKEN"
echo ""

echo "Waiting for single-user server..."
for i in $(seq 1 60); do
    CODE=$(curl -s -o /dev/null -w "%{http_code}" \
        -H "Authorization: token $API_TOKEN" \
        "http://localhost:9010/user/admin/api/status" 2>/dev/null || echo "000")
    if [ "$CODE" = "200" ]; then
        echo "Single-user server ready — MCP endpoint at /user/admin/mcp"
        break
    fi
    sleep 1
done
MCP

RUN chmod +x /app/start_mcp.sh

ENV MCP_SHTTP_SERVERS='[{"url": "http://jupyter.internal:9010/user/admin/mcp", "api_key": "mcp-token-tbench-2024"}]'

WORKDIR /app/research
