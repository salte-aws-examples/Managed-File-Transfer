pipeline {
    agent none

    environment {
        SHORT_SHA = "${GIT_COMMIT.take(7)}"
        TF_IMAGE  = 'hashicorp/terraform:1.7'
    }

    stages {

        // ── Scan: feature, fix, main, release branches ───────────────────
        stage('Scan') {
            when {
                anyOf {
                    branch 'feature/*'
                    branch 'fix/*'
                    branch 'main'
                    branch 'release/*'
                }
            }
            agent {
                docker {
                    image "${TF_IMAGE}"
                    label 'nonprod'
                    args  '-v /tmp/tfcache:/root/.terraform.d/plugin-cache'
                }
            }
            steps {
                sh 'terraform fmt -check -recursive'
                sh 'terraform init -backend=false'
                sh 'terraform validate'
            }
        }

        // ── Nonprod: main branch ─────────────────────────────────────────
        stage('Terraform Plan (Nonprod)') {
            when { branch 'main' }
            agent {
                docker {
                    image "${TF_IMAGE}"
                    label 'nonprod'
                    args  '-v /tmp/tfcache:/root/.terraform.d/plugin-cache'
                }
            }
            steps {
                script {
                    sh 'terraform init'
                    sh 'terraform plan -out=tfplan.binary 2>&1 | tee tfplan.txt'
                    env.TF_PLAN_OUTPUT = readFile('tfplan.txt').trim()
                }
            }
            post {
                always {
                    archiveArtifacts artifacts: 'tfplan.txt', fingerprint: true
                }
            }
        }

        stage('Approve Nonprod Apply') {
            agent none
            when { branch 'main' }
            steps {
                script {
                    input(
                        message: "Review nonprod plan then approve.\n\n${env.TF_PLAN_OUTPUT}",
                        ok: 'Apply'
                    )
                }
            }
        }

        stage('Terraform Apply (Nonprod)') {
            when { branch 'main' }
            agent {
                docker {
                    image "${TF_IMAGE}"
                    label 'nonprod'
                    args  '-v /tmp/tfcache:/root/.terraform.d/plugin-cache'
                }
            }
            steps {
                sh 'terraform apply tfplan.binary'
            }
        }

        // ── Production: prod-* tag ───────────────────────────────────────
        stage('Change Management Check') {
            when { tag pattern: 'prod-.+', comparator: 'REGEXP' }
            agent {
                docker {
                    image 'curlimages/curl:latest'
                    label 'prod'
                }
            }
            steps {
                script {
                    def approved = sh(
                        script: "./cm-check.sh ${TAG_NAME} ${SHORT_SHA}",
                        returnStatus: true
                    ) == 0
                    if (!approved) {
                        error("No approved change request found for tag ${TAG_NAME} at commit ${SHORT_SHA} — aborting")
                    }
                }
            }
        }

        stage('Terraform Plan (Prod)') {
            when { tag pattern: 'prod-.+', comparator: 'REGEXP' }
            agent {
                docker {
                    image "${TF_IMAGE}"
                    label 'prod'
                    args  '-v /tmp/tfcache:/root/.terraform.d/plugin-cache'
                }
            }
            steps {
                script {
                    sh 'terraform init'
                    sh 'terraform plan -out=tfplan.binary 2>&1 | tee tfplan.txt'
                    env.TF_PLAN_OUTPUT = readFile('tfplan.txt').trim()
                }
            }
            post {
                always {
                    archiveArtifacts artifacts: 'tfplan.txt', fingerprint: true
                }
            }
        }

        stage('Approve Prod Apply') {
            agent none
            when { tag pattern: 'prod-.+', comparator: 'REGEXP' }
            steps {
                script {
                    input(
                        message: "Review prod plan for ${TAG_NAME} then approve.\n\n${env.TF_PLAN_OUTPUT}",
                        ok: 'Apply',
                        submitter: 'wilma',
                        submitterParameter: 'APPROVED_BY'
                    )
                    echo "Production deployment approved by: ${env.APPROVED_BY}"
                }
            }
        }

        stage('Terraform Apply (Prod)') {
            when { tag pattern: 'prod-.+', comparator: 'REGEXP' }
            agent {
                docker {
                    image "${TF_IMAGE}"
                    label 'prod'
                    args  '-v /tmp/tfcache:/root/.terraform.d/plugin-cache'
                }
            }
            steps {
                sh 'terraform apply tfplan.binary'
            }
        }

        // ── Preview: preview-* tag on feature/fix branch ─────────────────
        stage('Terraform Plan (Preview)') {
            when { tag pattern: 'preview-.+', comparator: 'REGEXP' }
            agent {
                docker {
                    image "${TF_IMAGE}"
                    label 'nonprod'
                    args  '-v /tmp/tfcache:/root/.terraform.d/plugin-cache'
                }
            }
            steps {
                script {
                    sh 'terraform init'
                    sh "terraform plan -var='preview_id=${TAG_NAME}' -out=tfplan.binary 2>&1 | tee tfplan.txt"
                    env.TF_PLAN_OUTPUT = readFile('tfplan.txt').trim()
                }
            }
            post {
                always {
                    archiveArtifacts artifacts: 'tfplan.txt', fingerprint: true
                }
            }
        }

        stage('Approve Preview Apply') {
            agent none
            when { tag pattern: 'preview-.+', comparator: 'REGEXP' }
            steps {
                script {
                    input(
                        message: "Review preview plan for ${TAG_NAME} then approve.\n\n${env.TF_PLAN_OUTPUT}",
                        ok: 'Apply'
                    )
                }
            }
        }

        stage('Terraform Apply (Preview)') {
            when { tag pattern: 'preview-.+', comparator: 'REGEXP' }
            agent {
                docker {
                    image "${TF_IMAGE}"
                    label 'nonprod'
                    args  '-v /tmp/tfcache:/root/.terraform.d/plugin-cache'
                }
            }
            steps {
                sh 'terraform apply tfplan.binary'
            }
        }

        stage('Destroy Preview') {
            when { tag pattern: 'preview-.+', comparator: 'REGEXP' }
            agent {
                docker {
                    image "${TF_IMAGE}"
                    label 'nonprod'
                    args  '-v /tmp/tfcache:/root/.terraform.d/plugin-cache'
                }
            }
            steps {
                script {
                    timeout(time: 24, unit: 'HOURS') {
                        input(
                            message: "Preview environment '${TAG_NAME}' is live. Destroy when done?",
                            ok: 'Destroy'
                        )
                    }
                    sh "terraform destroy -var='preview_id=${TAG_NAME}' -auto-approve"
                }
            }
        }
    }

    post {
        failure {
            echo "Pipeline failed — notify team"
        }
        success {
            echo "Pipeline completed successfully"
        }
    }
}
