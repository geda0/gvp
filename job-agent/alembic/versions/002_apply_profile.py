"""apply profile

Revision ID: 002
Revises: 001
Create Date: 2026-04-07

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '002'
down_revision: Union[str, None] = '001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
  op.create_table(
    'apply_profile',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('full_name', sa.String(length=512), nullable=True),
    sa.Column('email', sa.String(length=512), nullable=True),
    sa.Column('phone', sa.String(length=128), nullable=True),
    sa.Column('linkedin_url', sa.String(length=2048), nullable=True),
    sa.Column('work_authorization', sa.String(length=512), nullable=True),
    sa.Column('cover_letter_template', sa.Text(), nullable=True),
    sa.Column('answers_defaults_json', sa.JSON(), nullable=True),
    sa.Column('learned_json', sa.JSON(), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
    sa.PrimaryKeyConstraint('id'),
  )
  op.execute("INSERT INTO apply_profile (id, learned_json, answers_defaults_json) VALUES (1, '{}', '{}')")


def downgrade() -> None:
  op.drop_table('apply_profile')
