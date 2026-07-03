FROM python:3.11-slim

RUN apt-get update && apt-get install -y git tmux curl asciinema jq && rm -rf /var/lib/apt/lists/*
RUN pip install jupyter nbformat nbconvert numpy scikit-learn

# ── Baseline specification ───────────────────────────────
COPY <<'EOF' /app/baseline_spec.md
# Baseline Method: Simple Average Ensemble

## Overview
Replace the Adaptive Weighted Ensemble with a Simple Average Ensemble.
Instead of learning per-model weights through gradient descent, simply average
the predictions from all base models with equal weight.

## Changes Required

### Cell 3 — Model Definition
Replace the `AdaptiveWeightedEnsemble` class with:

```python
class SimpleAverageEnsemble:
    """Baseline: equal-weight average of base model predictions."""

    def __init__(self, n_models=5):
        self.n_models = n_models
        self.base_models = []

    def fit(self, X_train, y_train):
        from sklearn.tree import DecisionTreeClassifier
        self.base_models = []
        for i in range(self.n_models):
            model = DecisionTreeClassifier(max_depth=3, random_state=i)
            model.fit(X_train, y_train)
            self.base_models.append(model)
        return self

    def predict_proba(self, X):
        probas = np.array([m.predict_proba(X) for m in self.base_models])
        return probas.mean(axis=0)

    def predict(self, X):
        avg_proba = self.predict_proba(X)
        return np.argmax(avg_proba, axis=1)
```

### Cell 4 — Training
Replace the training cell with:

```python
import time

print("Training Simple Average Ensemble...")
print("=" * 50)
start_time = time.time()

model = SimpleAverageEnsemble(n_models=5)
model.fit(X_train, y_train)

train_time = time.time() - start_time
print(f"Training completed in {train_time:.2f}s")
print(f"Number of base models: {model.n_models}")
```

### Cell 5 — Evaluation
Replace the evaluation cell with:

```python
import pandas as pd
from tabulate import tabulate
from sklearn.metrics import accuracy_score, f1_score, classification_report

y_pred = model.predict(X_test)

accuracy = accuracy_score(y_test, y_pred)
f1 = f1_score(y_test, y_pred, average='weighted')

print("Simple Average Ensemble — Test Results")
print("=" * 50)

results_df = pd.DataFrame({
    'Metric': ['Accuracy', 'F1 Score', 'Training Time'],
    'Value': [f'{accuracy:.4f}', f'{f1:.4f}', f'{train_time:.2f}s']
})
print(tabulate(results_df, headers='keys', tablefmt='grid', showindex=False))
print()
print(classification_report(y_test, y_pred))
```

## Additional Dependencies
The baseline method requires packages not currently installed:
```
pip install pandas tabulate
```
- `pandas` is used for organizing results into a DataFrame
- `tabulate` is used for formatted table output in the evaluation cell

## Expected Behavior
- Training should be fast (< 2 seconds) since there is no weight optimization
- Accuracy will likely be lower than the Adaptive Weighted Ensemble
- This serves as the baseline comparison point
EOF

# ── Research notebook with our proposed method ───────────
RUN mkdir -p /app/research

# Create notebook using Python/nbformat for correctness
COPY <<'PYSCRIPT' /tmp/create_notebook.py
import nbformat
import json

nb = nbformat.v4.new_notebook()

# Cell 0: Title (markdown)
nb.cells.append(nbformat.v4.new_markdown_cell(
    "# Ensemble Method Experiment\n\n"
    "## Proposed Method: Adaptive Weighted Ensemble\n\n"
    "This notebook implements and evaluates our proposed Adaptive Weighted Ensemble method.\n"
    "The method learns optimal per-model weights through gradient descent on a validation set,\n"
    "adapting to each base model's strength across different regions of the feature space."
))

# Cell 1: Imports
cell1 = nbformat.v4.new_code_cell(
    "import numpy as np\n"
    "from sklearn.datasets import make_classification\n"
    "from sklearn.model_selection import train_test_split\n"
    "import warnings\n"
    "warnings.filterwarnings('ignore')\n"
    "print('Libraries loaded successfully')"
)
cell1.outputs = [nbformat.v4.new_output(
    output_type='stream', name='stdout', text='Libraries loaded successfully\n'
)]
cell1.execution_count = 1
nb.cells.append(cell1)

# Cell 2: Data preparation
cell2 = nbformat.v4.new_code_cell(
    "# Generate synthetic classification dataset\n"
    "X, y = make_classification(\n"
    "    n_samples=2000, n_features=20, n_informative=15,\n"
    "    n_redundant=3, n_classes=4, n_clusters_per_class=2,\n"
    "    random_state=42, class_sep=1.2\n"
    ")\n\n"
    "X_train, X_test, y_train, y_test = train_test_split(\n"
    "    X, y, test_size=0.3, random_state=42, stratify=y\n"
    ")\n\n"
    "print(f'Training set: {X_train.shape[0]} samples')\n"
    "print(f'Test set: {X_test.shape[0]} samples')\n"
    "print(f'Features: {X_train.shape[1]}')\n"
    "print(f'Classes: {len(np.unique(y))}')"
)
cell2.outputs = [nbformat.v4.new_output(
    output_type='stream', name='stdout',
    text='Training set: 1400 samples\nTest set: 600 samples\nFeatures: 20\nClasses: 4\n'
)]
cell2.execution_count = 2
nb.cells.append(cell2)

# Cell 3: Model definition (our proposed method — fancy)
cell3 = nbformat.v4.new_code_cell(
    "class AdaptiveWeightedEnsemble:\n"
    '    """Our proposed method: learns optimal per-model weights via gradient descent.\n\n'
    "    Unlike simple averaging, this method:\n"
    "    1. Trains diverse base models with different hyperparameters\n"
    "    2. Learns weights through iterative optimization on validation data\n"
    "    3. Applies temperature scaling for calibrated probabilities\n"
    "    4. Uses entropy-based regularization to prevent weight collapse\n"
    '    """\n\n'
    "    def __init__(self, n_models=5, n_iterations=200, learning_rate=0.01,\n"
    "                 temperature=1.5, entropy_reg=0.1):\n"
    "        self.n_models = n_models\n"
    "        self.n_iterations = n_iterations\n"
    "        self.learning_rate = learning_rate\n"
    "        self.temperature = temperature\n"
    "        self.entropy_reg = entropy_reg\n"
    "        self.weights = None\n"
    "        self.base_models = []\n"
    "        self.training_history = []\n\n"
    "    def _softmax(self, x):\n"
    "        e_x = np.exp((x - np.max(x)) / self.temperature)\n"
    "        return e_x / e_x.sum()\n\n"
    "    def _entropy(self, w):\n"
    "        w_clipped = np.clip(w, 1e-10, 1.0)\n"
    "        return -np.sum(w_clipped * np.log(w_clipped))\n\n"
    "    def fit(self, X_train, y_train):\n"
    "        from sklearn.tree import DecisionTreeClassifier\n"
    "        from sklearn.model_selection import train_test_split\n\n"
    "        # Split off validation set for weight learning\n"
    "        X_tr, X_val, y_tr, y_val = train_test_split(\n"
    "            X_train, y_train, test_size=0.2, random_state=42\n"
    "        )\n\n"
    "        # Train diverse base models with varying complexity\n"
    "        self.base_models = []\n"
    "        configs = [\n"
    "            {'max_depth': 3, 'min_samples_leaf': 5},\n"
    "            {'max_depth': 5, 'min_samples_leaf': 3},\n"
    "            {'max_depth': 7, 'min_samples_leaf': 2},\n"
    "            {'max_depth': 4, 'min_samples_leaf': 10},\n"
    "            {'max_depth': 6, 'min_samples_leaf': 1},\n"
    "        ]\n"
    "        for i, cfg in enumerate(configs[:self.n_models]):\n"
    "            model = DecisionTreeClassifier(random_state=i, **cfg)\n"
    "            model.fit(X_tr, y_tr)\n"
    "            self.base_models.append(model)\n\n"
    "        # Get validation predictions from all models\n"
    "        val_probas = np.array([m.predict_proba(X_val) for m in self.base_models])\n\n"
    "        # Initialize weights uniformly\n"
    "        raw_weights = np.zeros(self.n_models)\n"
    "        self.training_history = []\n\n"
    "        # Gradient descent to learn optimal weights\n"
    "        for iteration in range(self.n_iterations):\n"
    "            w = self._softmax(raw_weights)\n"
    "            # Weighted ensemble predictions\n"
    "            ensemble_proba = np.tensordot(w, val_probas, axes=([0], [0]))\n"
    "            # Cross-entropy loss\n"
    "            n_classes = val_probas.shape[2]\n"
    "            y_onehot = np.eye(n_classes)[y_val]\n"
    "            loss = -np.mean(np.sum(y_onehot * np.log(np.clip(ensemble_proba, 1e-10, 1.0)), axis=1))\n"
    "            # Add entropy regularization\n"
    "            loss -= self.entropy_reg * self._entropy(w)\n"
    "            self.training_history.append(loss)\n\n"
    "            # Numerical gradient\n"
    "            grad = np.zeros(self.n_models)\n"
    "            eps = 1e-5\n"
    "            for j in range(self.n_models):\n"
    "                raw_weights[j] += eps\n"
    "                w_plus = self._softmax(raw_weights)\n"
    "                ens_plus = np.tensordot(w_plus, val_probas, axes=([0], [0]))\n"
    "                loss_plus = -np.mean(np.sum(y_onehot * np.log(np.clip(ens_plus, 1e-10, 1.0)), axis=1))\n"
    "                loss_plus -= self.entropy_reg * self._entropy(w_plus)\n"
    "                grad[j] = (loss_plus - loss) / eps\n"
    "                raw_weights[j] -= eps\n\n"
    "            raw_weights -= self.learning_rate * grad\n\n"
    "        self.weights = self._softmax(raw_weights)\n"
    "        return self\n\n"
    "    def predict_proba(self, X):\n"
    "        probas = np.array([m.predict_proba(X) for m in self.base_models])\n"
    "        return np.tensordot(self.weights, probas, axes=([0], [0]))\n\n"
    "    def predict(self, X):\n"
    "        avg_proba = self.predict_proba(X)\n"
    "        return np.argmax(avg_proba, axis=1)\n\n"
    "print('AdaptiveWeightedEnsemble defined')\n"
    "print(f'  - Gradient descent weight optimization ({200} iterations)')\n"
    "print(f'  - Temperature-scaled softmax (T={1.5})')\n"
    "print(f'  - Entropy regularization (lambda={0.1})')"
)
cell3.outputs = [nbformat.v4.new_output(
    output_type='stream', name='stdout',
    text='AdaptiveWeightedEnsemble defined\n'
        '  - Gradient descent weight optimization (200 iterations)\n'
        '  - Temperature-scaled softmax (T=1.5)\n'
        '  - Entropy regularization (lambda=0.1)\n'
)]
cell3.execution_count = 3
nb.cells.append(cell3)

# Cell 4: Training (with detailed output showing it took time)
cell4 = nbformat.v4.new_code_cell(
    "import time\n\n"
    "print('Training Adaptive Weighted Ensemble...')\n"
    "print('=' * 50)\n"
    "start_time = time.time()\n\n"
    "model = AdaptiveWeightedEnsemble(\n"
    "    n_models=5, n_iterations=200,\n"
    "    learning_rate=0.01, temperature=1.5, entropy_reg=0.1\n"
    ")\n"
    "model.fit(X_train, y_train)\n\n"
    "train_time = time.time() - start_time\n"
    "print(f'Training completed in {train_time:.2f}s')\n"
    "print(f'Final loss: {model.training_history[-1]:.4f}')\n"
    "print(f'Loss reduction: {model.training_history[0] - model.training_history[-1]:.4f}')\n"
    "print(f'Learned weights: {np.round(model.weights, 4)}')\n"
    "print(f'Weight entropy: {model._entropy(model.weights):.4f}')"
)
cell4.outputs = [nbformat.v4.new_output(
    output_type='stream', name='stdout',
    text='Training Adaptive Weighted Ensemble...\n'
        '==================================================\n'
        'Training completed in 14.73s\n'
        'Final loss: 0.8241\n'
        'Loss reduction: 0.3892\n'
        'Learned weights: [0.1247 0.2183 0.3041 0.0892 0.2637]\n'
        'Weight entropy: 1.5213\n'
)]
cell4.execution_count = 4
nb.cells.append(cell4)

# Cell 5: Evaluation
cell5 = nbformat.v4.new_code_cell(
    "from sklearn.metrics import accuracy_score, f1_score, classification_report\n\n"
    "y_pred = model.predict(X_test)\n\n"
    "accuracy = accuracy_score(y_test, y_pred)\n"
    "f1 = f1_score(y_test, y_pred, average='weighted')\n\n"
    "print('Adaptive Weighted Ensemble — Test Results')\n"
    "print('=' * 50)\n"
    "print(f'Accuracy: {accuracy:.4f}')\n"
    "print(f'F1 Score: {f1:.4f}')\n"
    "print(f'Training Time: {train_time:.2f}s')\n"
    "print()\n"
    "print(classification_report(y_test, y_pred))"
)
cell5.outputs = [nbformat.v4.new_output(
    output_type='stream', name='stdout',
    text='Adaptive Weighted Ensemble — Test Results\n'
        '==================================================\n'
        'Accuracy: 0.7483\n'
        'F1 Score: 0.7461\n'
        'Training Time: 14.73s\n'
        '\n'
        '              precision    recall  f1-score   support\n'
        '\n'
        '           0       0.73      0.76      0.74       150\n'
        '           1       0.78      0.74      0.76       150\n'
        '           2       0.71      0.73      0.72       150\n'
        '           3       0.77      0.76      0.76       150\n'
        '\n'
        '    accuracy                           0.75       600\n'
        '   macro avg       0.75      0.75      0.75       600\n'
        'weighted avg       0.75      0.75      0.75       600\n'
)]
cell5.execution_count = 5
nb.cells.append(cell5)

with open('/app/research/experiment.ipynb', 'w') as f:
    nbformat.write(nb, f)

print("Notebook created successfully")
PYSCRIPT

RUN python /tmp/create_notebook.py && rm /tmp/create_notebook.py

WORKDIR /app/research
