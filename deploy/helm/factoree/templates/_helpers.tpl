{{- define "factoree.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "factoree.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "factoree.labels" -}}
{{ include "factoree.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "factoree.serviceAccountName" -}}
{{- default (include "factoree.fullname" .) .Values.serviceAccount.name -}}
{{- end -}}

{{- define "factoree.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{- define "factoree.databaseEnv" -}}
- name: FACTOREE_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ required "database.existingSecret is required" .Values.database.existingSecret }}
      key: {{ .Values.database.key }}
{{- end -}}

{{/* The infrastructure environment of the API and the worker. */}}
{{- define "factoree.env" -}}
{{ include "factoree.databaseEnv" . }}
- name: FACTOREE_MASTER_KEY
  valueFrom:
    secretKeyRef:
      name: {{ required "masterKey.existingSecret is required" .Values.masterKey.existingSecret }}
      key: {{ .Values.masterKey.key }}
- name: FACTOREE_TEMPORAL_ADDRESS
  value: {{ required "temporal.address is required" .Values.temporal.address | quote }}
- name: FACTOREE_TEMPORAL_NAMESPACE
  value: {{ .Values.temporal.namespace | quote }}
- name: FACTOREE_TEMPORAL_TASK_QUEUE
  value: {{ .Values.temporal.taskQueue | quote }}
{{- if .Values.temporal.apiKey.existingSecret }}
- name: FACTOREE_TEMPORAL_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.temporal.apiKey.existingSecret }}
      key: {{ .Values.temporal.apiKey.key }}
{{- end }}
- name: FACTOREE_PUBLIC_URL
  value: {{ required "publicURL is required" .Values.publicURL | quote }}
- name: FACTOREE_PORT
  value: {{ .Values.service.port | quote }}
- name: FACTOREE_LOG_LEVEL
  value: {{ .Values.logLevel | quote }}
{{- if .Values.temporalUi.enabled }}
- name: FACTOREE_TEMPORAL_UI_URL
  value: {{ printf "http://%s-temporal-ui:8080" (include "factoree.fullname" .) | quote }}
{{- end }}
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "factoree.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
fsGroup: 1000
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "factoree.containerSecurityContext" -}}
allowPrivilegeEscalation: false
capabilities:
  drop: ["ALL"]
{{- end -}}

{{- define "factoree.scheduling" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
