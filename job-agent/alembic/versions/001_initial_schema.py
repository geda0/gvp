"""initial schema

Revision ID: 001
Revises:
Create Date: 2026-04-07

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '001'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
  op.create_table(
    'companies',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('name', sa.String(length=512), nullable=False),
    sa.Column('ats_type', sa.String(length=32), nullable=True),
    sa.Column('board_token', sa.String(length=256), nullable=True),
    sa.Column('lever_slug', sa.String(length=256), nullable=True),
    sa.Column('career_page_url', sa.String(length=2048), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=True),
    sa.PrimaryKeyConstraint('id'),
  )
  op.create_table(
    'job_postings',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('company_id', sa.Integer(), nullable=False),
    sa.Column('source', sa.String(length=64), nullable=False),
    sa.Column('external_id', sa.String(length=256), nullable=False),
    sa.Column('title', sa.String(length=1024), nullable=False),
    sa.Column('location', sa.String(length=512), nullable=True),
    sa.Column('absolute_url', sa.String(length=4096), nullable=False),
    sa.Column('content_snippet', sa.Text(), nullable=True),
    sa.Column('raw_payload', sa.JSON(), nullable=True),
    sa.Column('first_seen', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_seen', sa.DateTime(timezone=True), nullable=True),
    sa.Column('match_score', sa.Integer(), nullable=True),
    sa.Column('match_reasons', sa.JSON(), nullable=True),
    sa.Column('user_dismissed', sa.Boolean(), nullable=True),
    sa.ForeignKeyConstraint(['company_id'], ['companies.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('source', 'external_id', name='uq_job_source_external'),
  )
  op.create_table(
    'applications',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('job_posting_id', sa.Integer(), nullable=False),
    sa.Column('status', sa.String(length=32), nullable=True),
    sa.Column('submitted_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('notes', sa.Text(), nullable=True),
    sa.Column('resume_version_id', sa.String(length=256), nullable=True),
    sa.Column('cover_letter_text', sa.Text(), nullable=True),
    sa.Column('answers_json', sa.JSON(), nullable=True),
    sa.Column('attachments_meta', sa.JSON(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['job_posting_id'], ['job_postings.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('job_posting_id'),
  )
  op.create_table(
    'application_events',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('application_id', sa.Integer(), nullable=False),
    sa.Column('event_type', sa.String(length=64), nullable=False),
    sa.Column('payload', sa.JSON(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['application_id'], ['applications.id'], ),
    sa.PrimaryKeyConstraint('id'),
  )


def downgrade() -> None:
  op.drop_table('application_events')
  op.drop_table('applications')
  op.drop_table('job_postings')
  op.drop_table('companies')
