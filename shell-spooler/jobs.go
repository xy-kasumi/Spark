// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"fmt"
	"sync"
	"time"

	"shell-spooler/comm"
)

type JobStatus string

const (
	JobWaiting   JobStatus = "WAITING"
	JobRunning   JobStatus = "RUNNING"
	JobCompleted JobStatus = "COMPLETED"
	JobCanceled  JobStatus = "CANCELED"
)

type Job struct {
	ID          string
	Commands    []string
	Signals     map[string]float32
	Status      JobStatus
	TimeAdded   time.Time
	TimeStarted *time.Time
	TimeEnded   *time.Time
}

// JobSched stores list of jobs and manage their execution
type JobSched struct {
	mu        sync.Mutex
	jobs      []Job
	nextJobID int

	commInstance *comm.Comm
}

func NewJobSched(commInstance *comm.Comm) *JobSched {
	return &JobSched{
		nextJobID:    1,
		commInstance: commInstance,
	}
}

func (js *JobSched) hasPendingJob() bool {
	js.mu.Lock()
	defer js.mu.Unlock()

	for _, job := range js.jobs {
		if job.Status == JobWaiting || job.Status == JobRunning {
			return true
		}
	}
	return false
}

func (js *JobSched) findWaitingJob() *Job {
	js.mu.Lock()
	defer js.mu.Unlock()

	for i := range js.jobs {
		if js.jobs[i].Status == JobWaiting {
			return &js.jobs[i]
		}
	}
	return nil
}

func (js *JobSched) keepSendingSignals(signal string, value float32) {
	interval := time.Duration(value * float32(time.Second))
	for {
		time.Sleep(interval)
		js.commInstance.Write(signal)
	}
}

func (js *JobSched) keepExecutingJobs() {
	for {
		// Wait until a job become runnable.
		var job *Job
		for {
			job = js.findWaitingJob()
			if job != nil && js.commInstance.CommandQueueLength() == 0 {
				break
			}
			time.Sleep(500 * time.Millisecond)
		}

		// Execute job
		tStart := time.Now().Local()
		job.Status = JobRunning
		job.TimeStarted = &tStart

		for signal, value := range job.Signals {
			go js.keepSendingSignals(signal, value)
		}
		for _, command := range job.Commands {
			js.commInstance.Write(command)
		}

		// Wait job completion (== cmd queue become empty)
		for {
			if js.commInstance.CommandQueueLength() == 0 {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}

		// Mark job as completed
		tEnd := time.Now().Local()
		job.Status = JobCompleted
		job.TimeEnded = &tEnd
	}
}

func (js *JobSched) AddJob(commands []string, signals map[string]float32) (string, bool) {
	js.mu.Lock()
	defer js.mu.Unlock()

	if js.hasPendingJobUnsafe() || js.commInstance.CommandQueueLength() > 0 {
		return "", false
	}

	// Generate job ID
	jobID := fmt.Sprintf("jb%d", js.nextJobID)
	js.nextJobID++

	// Create new job
	job := Job{
		ID:        jobID,
		Commands:  commands,
		Signals:   signals,
		Status:    JobWaiting,
		TimeAdded: time.Now(),
	}

	// Add to jobs list
	js.jobs = append(js.jobs, job)

	return jobID, true
}

func (js *JobSched) ListJobs() []Job {
	js.mu.Lock()
	defer js.mu.Unlock()

	// Return copy of jobs slice
	jobs := make([]Job, len(js.jobs))
	copy(jobs, js.jobs)
	return jobs
}

// hasPendingJobUnsafe is the unsafe version that doesn't acquire mutex
// Used internally when mutex is already held
func (js *JobSched) hasPendingJobUnsafe() bool {
	for _, job := range js.jobs {
		if job.Status == JobWaiting || job.Status == JobRunning {
			return true
		}
	}
	return false
}
